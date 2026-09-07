(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme =
    param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();

(() => {
  "use strict";

  // Keep the required palette detection, then prefer VS Code's native/HC theme.
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
  const renderId = document.body.dataset.renderId;
  const actions = new Set(["previous", "next", "complete", "lab", "quiz", "check", "explain", "hint", "portal-walkthrough", "revert-unit", "source", "reset", "outputs"]);
  const buttons = Array.from(document.querySelectorAll("button[data-action]"));
  const disabled = new Map(buttons.map(button => [button, button.disabled]));
  const status = document.getElementById("action-status");
  const main = document.querySelector("main");
  let busy = false;

  const setBusy = value => {
    busy = value;
    for (const button of buttons) {
      button.disabled = value || disabled.get(button);
    }
    main?.setAttribute("aria-busy", String(value));
    for (const link of document.querySelectorAll("a[data-href]")) {
      link.setAttribute("aria-disabled", String(value));
    }
    if (status) { status.textContent = value ? "Working…" : "Ready."; }
  };

  const send = (action, href) => {
    if (busy || !renderId) { return; }
    if (action !== "link" && !actions.has(action)) { return; }
    setBusy(true);
    try {
      // Never send a selection, path, executable, arbitrary URI, or command ID.
      vscode.postMessage(action === "link" ? { action, renderId, href } : { action, renderId });
    } catch {
      setBusy(false);
      if (status) { status.textContent = "The action could not be sent. Reopen this activity and try again."; }
    }
  };

  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) { return; }
    const anchor = event.target.closest("a");
    if (anchor) {
      // HTTPS anchors are inert even without JS; there is never native navigation.
      event.preventDefault();
      if (anchor.classList.contains("skip-link")) {
        const lesson = document.getElementById("lesson");
        lesson?.focus();
        lesson?.scrollIntoView({ block: "start" });
      } else if (anchor.dataset.href) {
        send("link", anchor.dataset.href);
      }
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (button && !button.disabled && actions.has(button.dataset.action)) {
      send(button.dataset.action);
    }
  });

  document.addEventListener("keydown", event => {
    if (!(event.target instanceof Element)) { return; }
    const anchor = event.target.closest("a[data-href]");
    if (anchor && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      anchor.click();
    }
  });

  for (const eventName of ["auxclick", "dragstart"]) {
    document.addEventListener(eventName, event => {
      if (event.target instanceof Element && event.target.closest("a")) { event.preventDefault(); }
    });
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (message && message.type === "actionFinished" && message.renderId === renderId) { setBusy(false); }
  });
})();