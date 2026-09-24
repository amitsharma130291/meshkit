function setPending(button: HTMLButtonElement, pending: boolean): void {
  const label = button.querySelector<HTMLElement>("[data-label]");
  const spinner = button.querySelector<HTMLElement>("[data-spinner]");
  button.disabled = pending;
  if (label) label.hidden = pending;
  if (spinner) spinner.hidden = !pending;
}

function initContactForm(): void {
  const form = document.querySelector<HTMLFormElement>("#contact-form");
  const successEl = document.querySelector<HTMLElement>("#contact-success");
  if (!form || !successEl) return;
  const button = form.querySelector<HTMLButtonElement>("[data-contact-submit]")!;
  const errorEl = form.querySelector<HTMLElement>("[data-contact-error]")!;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const data = new FormData(form);
    const name = (data.get("name") as string)?.trim();
    const email = (data.get("email") as string)?.trim();
    const subject = (data.get("subject") as string)?.trim();
    const message = (data.get("message") as string)?.trim();
    if (!name || !email || !subject || !message) return;

    setPending(button, true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, subject, message }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? "Something went wrong sending your message. Please try again shortly.");
      }
      form.hidden = true;
      successEl.hidden = false;
      successEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      errorEl.textContent = error instanceof Error ? error.message : "Something went wrong sending your message. Please try again shortly.";
      errorEl.hidden = false;
      setPending(button, false);
    }
  });
}

initContactForm();
