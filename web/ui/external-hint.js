// D3: the standing `#compose-hint` caption and the post-continue toast both said the same thing on
// every external session, forever. The cue survives exactly once — the first time this phone is
// about to continue a session the machine owns — because "nothing is written until you send" is
// only surprising the first time. It clears itself on that first send and never returns.
export function createExternalHint({ hint, text, dismiss, loadSeen, saveSeen }) {
  let seen = loadSeen();

  const close = () => {
    seen = true;
    saveSeen(true);
    hint.hidden = true;
    text.textContent = '';
  };

  dismiss.addEventListener('click', close);

  return {
    update(message) {
      const show = !seen && message !== '';
      text.textContent = show ? message : '';
      hint.hidden = !show;
    },
    // Called from the composer's reset, which only runs after a send actually reached the harness.
    dismissAfterSend() {
      if (!hint.hidden) close();
    },
  };
}
