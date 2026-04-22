import { PLANE_IDS, VIEW_LABELS, type PlaneId } from './viewer-planes';

function oneViewCard(view: PlaneId): string {
  const name = VIEW_LABELS[view];
  return (
    `<div class="view-card compact" id="card-${view}">` +
      `<span class="view-dot" aria-hidden="true"></span>` +
      `<span class="view-name">${name}</span>` +
      `<span class="view-state">Closed</span>` +
      `<button type="button" class="open-view-btn" id="btn-${view}" disabled>Open</button>` +
    `</div>`
  );
}

/** Inner HTML for `.dash-views` on the 2D dashboard (matches prior static markup). */
export function formatDashboardViewCardsHtml(): string {
  return PLANE_IDS.map(oneViewCard).join('');
}
