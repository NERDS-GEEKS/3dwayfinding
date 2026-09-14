/**
 * Standalone entry for the 3D wayfinding app.
 *
 * The dashboard mounts this page behind its own router and session. Here it is
 * the whole application, so there is no project to inherit — the page's project
 * picker chooses one and sets the poi_type session that every Supabase read is
 * scoped by.
 *
 * Stylesheet order matches the dashboard's entry so the page renders
 * identically; wayfinding.css loads last because it is the page's own layer.
 */
import './styles/global.css';
import './styles/enterprise-theme.css';
import './styles/glass-theme.css';
import './styles/media.css';
import './styles/glass-animations.css';
import './styles/minimal-theme.css';
import './styles/floors.css';
import './styles/wayfinding.css';

import { initWayfindingPage } from './ui/wayfinding-page.js';

const root = document.getElementById('app');
if (root) initWayfindingPage(root, { requireLogin: false, forceLight: true });
else console.error('[wayfinding] #app not found');
