// Menu bar panel: missed alerts and what's flagged on the front pages right now.

let popState: any = null;

$('pop-run').innerHTML = icon('reload', 16);

async function renderPopover() {
  if (!popState) return;
  applyAppTheme(popState.theme);
  $('pop-status').textContent = popState.checking ? 'Checking front pages…' : `Checked ${fmtTime(popState.lastCheckAt)} · next ${fmtTime(popState.nextCheckAt)}`;
  $('pop-run').classList.toggle('spin', !!popState.checking);

  const [alerts, flagged]: [StoryView[], StoryView[]] = await Promise.all([api.alerts(), api.flaggedNow()]);
  const missed = alerts.filter((a) => a.unseen);
  const missedIds = new Set(missed.map((m) => m.id));
  const now = flagged.filter((f) => !missedIds.has(f.id));
  const parts: string[] = [];
  if (missed.length) parts.push(`<div class="section-title"><h2>Missed alerts · ${missed.length}</h2></div>${missed.map((s) => storyCard(s, { compact: true, showDate: true })).join('')}`);
  parts.push(
    `<div class="section-title"><h2>Flagged right now</h2></div>${
      now.length ? now.map((s) => storyCard(s, { compact: true })).join('') : `<div class="empty">Nothing big on the front pages right now.</div>`
    }`
  );
  const body = $('pop-body');
  body.innerHTML = parts.join('');
  paintColors(body);
  $('pop-seen').hidden = !missed.length;
}

wireCards($('pop-body'));
$('pop-run').onclick = () => api.runCheck();
$('pop-open').onclick = () => api.showWindow();
$('pop-seen').onclick = async () => {
  await api.markAlertsSeen();
  renderPopover();
};

api.onState((s: any) => {
  popState = s;
  renderPopover();
});
