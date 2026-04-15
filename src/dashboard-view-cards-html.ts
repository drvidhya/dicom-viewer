import { PLANE_IDS, VIEW_LABELS, type PlaneId } from './viewer-planes';

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function oneViewCard(view: PlaneId): string {
  const name = VIEW_LABELS[view];
  const a = escAttr(name);
  return (
    `<div class="view-card" id="card-${view}">` +
      `<div class="view-box-head">` +
        `<span class="view-dot" aria-hidden="true"></span>` +
        `<span class="view-name">${name}</span>` +
        `<span class="view-state">Closed</span>` +
        `<button type="button" class="open-view-btn" id="btn-${view}" disabled>Open</button>` +
      `</div>` +
      `<div class="view-box-sep"></div>` +
      `<div class="view-box-body">` +
        `<div class="slice-row">` +
          `<span>Slice</span>` +
          `<span class="slice-readout" id="slice-readout-${view}">— / —</span>` +
        `</div>` +
        `<input type="range" class="slice-slider" id="slider-${view}" min="1" max="1" value="1" disabled aria-label="${a} slice" />` +
      `</div>` +
    `</div>`
  );
}

/** Inner HTML for `.dash-views` on the 2D dashboard (matches prior static markup). */
export function formatDashboardViewCardsHtml(): string {
  return PLANE_IDS.map(oneViewCard).join('');
}
