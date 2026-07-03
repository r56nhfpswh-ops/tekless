const form = document.getElementById("check-form");
const phoneInput = document.getElementById("phone");
const countrySelect = document.getElementById("country");
const submitBtn = document.getElementById("submit-btn");
const resultsEl = document.getElementById("results");
const providerStatusEl = document.getElementById("provider-status");

const STATUS_LABEL = {
  breached: "Found in a breach",
  clean: "No breach found",
  error: "Error",
  not_configured: "Not configured",
};

async function loadProviderStatus() {
  const res = await fetch("/api/providers");
  const providers = await res.json();
  providerStatusEl.innerHTML = providers
    .map(
      (p) =>
        `<span class="pill ${p.configured ? "on" : "off"}">${p.name}: ${
          p.configured ? "ready" : "no API key"
        }</span>`
    )
    .join("");
}

function renderResults(data) {
  resultsEl.innerHTML = "";

  for (const r of data.results) {
    const card = document.createElement("div");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "card-header";
    header.innerHTML = `<span>${r.name}</span><span class="badge ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>`;
    card.appendChild(header);

    if (r.status === "breached" && r.breaches?.length) {
      const list = document.createElement("ul");
      list.className = "breach-list";
      for (const b of r.breaches) {
        const li = document.createElement("li");
        li.textContent = [b.name, b.date, b.details].filter(Boolean).join(" — ");
        list.appendChild(li);
      }
      card.appendChild(list);
    }

    if (r.status === "error") {
      const err = document.createElement("p");
      err.className = "error-text";
      err.textContent = r.error;
      card.appendChild(err);
    }

    if (r.status === "not_configured") {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Add an API key for this service to your .env file to enable it.";
      card.appendChild(hint);
    }

    resultsEl.appendChild(card);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking…";
  resultsEl.innerHTML = "";

  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phoneInput.value, country: countrySelect.value }),
    });
    const data = await res.json();

    if (!res.ok) {
      resultsEl.innerHTML = `<p class="error-text">${data.error}</p>`;
      return;
    }
    renderResults(data);
  } catch (err) {
    resultsEl.innerHTML = `<p class="error-text">Request failed: ${err.message}</p>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Check";
  }
});

loadProviderStatus();
