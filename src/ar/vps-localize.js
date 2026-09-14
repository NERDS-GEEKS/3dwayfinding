/**
 * Visual localization against a MultiSet map.
 *
 * Opens the rear camera, sends frames to MultiSet's VPS, and resolves with the
 * world position once a confident pose comes back. That position is in the same
 * space as the project's POIs and the Matterport scan points, so it can be used
 * directly to find the scan point the user is standing at.
 *
 * Frames are sent one at a time with a gap between them: the request is far
 * slower than the camera, and queueing them would pile up latency without
 * improving the chance of a fix.
 */
import { getMultisetToken, multisetApiUrl } from '../services/multiset.js';

const QUERY_URL = multisetApiUrl('/v1/vps/map/query-form');
/** Gap between attempts. Below this the requests overlap without helping. */
const ATTEMPT_GAP_MS = 1200;
/** Poses below this confidence are treated as "keep scanning". */
const MIN_CONFIDENCE = 0.35;

function buildForm(blob, mapCode, w, h) {
  const fd = new FormData();
  // MSET_ codes are map SETS and use a different field.
  if (String(mapCode).startsWith('MSET_')) fd.append('mapSetCode', mapCode);
  else fd.append('mapCode', mapCode);
  // 60° horizontal FOV is the usual phone rear camera; MultiSet needs some
  // intrinsic estimate and this is the same assumption the AR app makes.
  const focal = (w / 2) / Math.tan(Math.PI / 6);
  fd.append('queryImage', blob, 'frame.jpg');
  fd.append('fx', String(focal));
  fd.append('fy', String(focal));
  fd.append('px', String(w / 2));
  fd.append('py', String(h / 2));
  fd.append('width', String(w));
  fd.append('height', String(h));
  fd.append('isRightHanded', 'true');
  return fd;
}

/**
 * @param {{
 *   mapCode: string,
 *   clientId: string,
 *   clientSecret: string,
 *   video: HTMLVideoElement,
 *   onStatus?: (msg: string) => void,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{x:number,y:number,z:number, confidence:number}>}
 */
export async function localizeAgainstMap(opts) {
  const { mapCode, clientId, clientSecret, video, onStatus = () => {}, signal } = opts;
  const token = await getMultisetToken({ clientId, clientSecret });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let attempts = 0;

  for (;;) {
    if (signal?.aborted) throw new Error('Localization cancelled');
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));

    if (blob && blob.size > 100) {
      attempts += 1;
      onStatus(attempts === 1 ? 'Scanning…' : `Scanning… (${attempts})`);
      try {
        const res = await fetch(QUERY_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: buildForm(blob, mapCode, canvas.width, canvas.height),
          signal,
        });
        if (res.ok) {
          const data = await res.json();
          const pos = data?.position;
          const confidence = Number(data?.confidence ?? data?.score ?? 0);
          if ((data?.poseFound || pos) && pos) {
            if (confidence >= MIN_CONFIDENCE) {
              return {
                x: Number(pos.x ?? pos[0] ?? 0),
                y: Number(pos.y ?? pos[1] ?? 0),
                z: Number(pos.z ?? pos[2] ?? 0),
                confidence,
              };
            }
            onStatus(`Almost — hold steady (${Math.round(confidence * 100)}%)`);
          } else {
            onStatus('Point the camera at the room around you');
          }
        } else if (res.status === 401) {
          throw new Error('MultiSet rejected the token');
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // A dropped request is normal while walking — keep scanning.
        console.warn('[vps] attempt failed', err);
      }
    }

    await new Promise((r) => setTimeout(r, ATTEMPT_GAP_MS));
  }
}

/** Rear camera stream, or a clear reason why not. */
export async function openRearCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot open the camera');
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
}
