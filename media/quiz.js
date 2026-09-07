(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme =
    param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();

(() => {
  "use strict";

  const syncNativeTheme = () => {
    const classes = document.body.classList;
    if (classes.contains("vscode-light") || classes.contains("vscode-high-contrast-light")) {
      document.documentElement.setAttribute("data-theme", "light");
    } else if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  };
  syncNativeTheme();
  new MutationObserver(syncNativeTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  const vscode = acquireVsCodeApi();
  const { renderId, questionId } = document.body.dataset;
  const main = document.querySelector("main");
  const fieldset = document.getElementById("quiz-choices");
  const required = Number(fieldset?.dataset.required || 0);
  const graded = fieldset?.dataset.graded === "true";
  const inputs = Array.from(document.querySelectorAll('input[name="quiz-choice"]'));
  const buttons = Array.from(document.querySelectorAll("button[data-action]"));
  const disabled = new Map(buttons.map(button => [button, button.disabled]));
  const count = document.getElementById("selection-count");
  const status = document.getElementById("action-status");
  const actions = new Set(["submit", "next", "previous", "summary", "restart", "source", "link"]);
  let busy = false;
  const selected = () => inputs.filter(input => input.checked).map(input => input.value);

  // The browser holds only unsent choices. It never scores or stores attempts.
  const update = () => {
    const ids = selected();
    for (const input of inputs) {
      input.disabled = busy || graded;
      input.closest(".quiz-choice")?.classList.toggle("is-selected", input.checked);
    }
    for (const button of buttons) {
      button.disabled = busy || (button.dataset.action === "submit"
        ? graded || ids.length !== required
        : disabled.get(button));
    }
    if (count) { count.textContent = `${ids.length} of ${required} selected`; }
    main?.setAttribute("aria-busy", String(busy));
    for (const link of document.querySelectorAll("a[data-href]")) { link.setAttribute("aria-disabled", String(busy)); }
  };

  const send = (action, extra = {}) => {
    if (busy || !renderId || questionId === undefined || !actions.has(action)) { return; }
    if (action === "submit" && (graded || selected().length !== required)) { return; }
    busy = true;
    update();
    if (status) { status.textContent = "Working…"; }
    try { vscode.postMessage({ action, renderId, questionId, ...extra }); }
    catch {
      busy = false;
      update();
      if (status) { status.textContent = "The action could not be sent. Reopen the quiz and try again."; }
    }
  };

  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) { return; }
    const anchor = event.target.closest("a");
    if (anchor) {
      event.preventDefault();
      if (anchor.classList.contains("skip-link")) {
        document.getElementById(main?.dataset.focus)?.focus();
      } else if (anchor.dataset.href) { send("link", { href: anchor.dataset.href }); }
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (button && !button.disabled) {
      send(button.dataset.action, button.dataset.action === "submit" ? { selectedIds: selected() } : {});
      return;
    }
    // Labels contain only phrasing content. Make the entire Markdown choice card
    // clickable too, without hijacking its links or native input keyboard behavior.
    const card = event.target.closest(".quiz-choice");
    const input = card?.querySelector("input");
    if (input && !input.disabled) {
      if (event.target.closest("label")) { return; } // Native label forwards one click.
      if (event.target !== input) { input.click(); return; }
      if (input.type === "radio") { send("submit", { selectedIds: [input.value] }); }
    }
  });

  document.addEventListener("change", event => {
    if (!inputs.includes(event.target) || busy || graded) { return; }
    update();
    if (event.target.type === "radio") { send("submit", { selectedIds: [event.target.value] }); }
  });
  document.addEventListener("keydown", event => {
    if (!(event.target instanceof Element)) { return; }
    const anchor = event.target.closest("a[data-href]");
    if (anchor && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); anchor.click(); }
  });
  for (const name of ["auxclick", "dragstart"]) {
    document.addEventListener(name, event => {
      if (event.target instanceof Element && event.target.closest("a")) { event.preventDefault(); }
    });
  }
  window.addEventListener("message", event => {
    const message = event.data;
    if (message?.type === "actionFinished" && message.renderId === renderId) {
      busy = false;
      update();
      if (status) { status.textContent = "Ready."; }
    }
  });
  // New HTML means a new generation: focus the question, feedback, or results.
  update();
  document.getElementById(main?.dataset.focus)?.focus();
})();