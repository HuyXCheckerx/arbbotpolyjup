const urlParams = new URLSearchParams(window.location.search);
const scannerPort = urlParams.get("scannerPort") || "3210";
const STATUS_URL = `http://127.0.0.1:${scannerPort}/api/status`;

let currentFilter = "all";
let cachedEvents = [];

// DOM Elements
const el = {
  modeTag: document.getElementById("modeTag"),
  haltTag: document.getElementById("haltTag"),
  topPnl: document.getElementById("topPnl"),
  topOpenPos: document.getElementById("topOpenPos"),
  topPolyBal: document.getElementById("topPolyBal"),
  topJupBal: document.getElementById("topJupBal"),
  topSolBal: document.getElementById("topSolBal"),
  connPill: document.getElementById("connPill"),
  connLabel: document.getElementById("connLabel"),

  posCount: document.getElementById("posCount"),
  resolutionMeta: document.getElementById("resolutionMeta"),
  positionsList: document.getElementById("positionsList"),
  noPositions: document.getElementById("noPositions"),

  phase5m: document.getElementById("phase5m"),
  msg5m: document.getElementById("msg5m"),
  polyRef5m: document.getElementById("polyRef5m"),
  jupRef5m: document.getElementById("jupRef5m"),
  diff5m: document.getElementById("diff5m"),
  polyUp5m: document.getElementById("polyUp5m"),
  polyDown5m: document.getElementById("polyDown5m"),
  jupUp5m: document.getElementById("jupUp5m"),
  jupDown5m: document.getElementById("jupDown5m"),
  edgeBox5m: document.getElementById("edgeBox5m"),
  routeLabel5m: document.getElementById("routeLabel5m"),
  routeEdge5m: document.getElementById("routeEdge5m"),
  routeDetails5m: document.getElementById("routeDetails5m"),

  phase15m: document.getElementById("phase15m"),
  msg15m: document.getElementById("msg15m"),
  polyRef15m: document.getElementById("polyRef15m"),
  jupRef15m: document.getElementById("jupRef15m"),
  diff15m: document.getElementById("diff15m"),
  polyUp15m: document.getElementById("polyUp15m"),
  polyDown15m: document.getElementById("polyDown15m"),
  jupUp15m: document.getElementById("jupUp15m"),
  jupDown15m: document.getElementById("jupDown15m"),
  edgeBox15m: document.getElementById("edgeBox15m"),
  routeLabel15m: document.getElementById("routeLabel15m"),
  routeEdge15m: document.getElementById("routeEdge15m"),
  routeDetails15m: document.getElementById("routeDetails15m"),

  polyFeedDot: document.getElementById("polyFeedDot"),
  polyFeedStatus: document.getElementById("polyFeedStatus"),
  jupFeedDot: document.getElementById("jupFeedDot"),
  jupFeedStatus: document.getElementById("jupFeedStatus"),

  eventCount: document.getElementById("eventCount"),
  eventsContainer: document.getElementById("eventsContainer"),

  lastActionText: document.getElementById("lastActionText"),
  lastActionTime: document.getElementById("lastActionTime"),
};

// Filter event listeners
document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    renderEvents();
  });
});

function formatUsd(val) {
  if (val === null || val === undefined || isNaN(Number(val))) return "—";
  const num = Number(val);
  return `${num < 0 ? "-" : ""}$${Math.abs(num).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatTime(isoStr) {
  if (!isoStr) return "—";
  try {
    const d = new Date(isoStr);
    return d.toISOString().substring(11, 19) + " UTC";
  } catch {
    return isoStr;
  }
}

function renderPositions(positions = [], awaitingCount = 0) {
  el.posCount.textContent = positions.length;
  el.resolutionMeta.textContent = `${awaitingCount} awaiting settlement`;

  if (!positions || positions.length === 0) {
    el.positionsList.innerHTML = `<div class="empty-state">NO ACTIVE EXPOSURE — ENGINE SCANNING FOR QUALIFIED CANDIDATES</div>`;
    return;
  }

  let html = "";
  for (const pos of positions) {
    const hedgeStatus = pos.hedgeStatus || (pos.isHedged ? "perfect" : "exposure_error");
    const isPerfect = hedgeStatus === "perfect";
    const isBoundedResidual = hedgeStatus === "bounded_residual";
    const isRecoveryPlanning = hedgeStatus === "recovery_planning";
    const residualPercent = pos.contractSkewBps === null || pos.contractSkewBps === undefined
      ? null
      : (Number(pos.contractSkewBps) / 100).toFixed(2);
    const badgeClass = isPerfect ? "green" : isBoundedResidual || isRecoveryPlanning ? "amber" : "red";
    const badgeLabel = isPerfect
      ? "✔ PERFECTLY HEDGED"
      : isBoundedResidual
        ? `◆ HEDGED · ${escapeHtml(residualPercent || "0.00")}% RESIDUAL`
        : isRecoveryPlanning
          ? "◆ ISOLATED · QUOTE REPAIR"
          : "✖ EXPOSURE ERROR";
    const cardClass = isPerfect ? "hedged-perfect" : isBoundedResidual || isRecoveryPlanning ? "hedged-residual" : "hedged-bad";
    const skewColor = isPerfect ? "var(--green)" : isBoundedResidual || isRecoveryPlanning ? "var(--amber)" : "var(--red)";

    const polySideClass = pos.polymarketOutcome.toUpperCase() === "UP" ? "up" : "down";
    const jupSideClass = pos.jupiterOutcome.toUpperCase() === "UP" ? "up" : "down";

    const positionId = escapeHtml(pos.id);
    const duration = escapeHtml(pos.duration);
    const start = escapeHtml(formatTime(pos.start));
    const end = escapeHtml(formatTime(pos.end));
    const polymarketOutcome = escapeHtml(pos.polymarketOutcome);
    const jupiterOutcome = escapeHtml(pos.jupiterOutcome);
    const polymarketContracts = escapeHtml(pos.polymarketContracts);
    const jupiterContracts = escapeHtml(pos.jupiterContracts);
    const jupiterQuotedContracts = pos.jupiterQuotedContracts == null
      ? "—"
      : escapeHtml(pos.jupiterQuotedContracts);
    const polymarketCostUsd = escapeHtml(pos.polymarketCostUsd);
    const jupiterCostUsd = escapeHtml(pos.jupiterCostUsd);
    const skewVal = escapeHtml(pos.contractSkew || "0.00");
    const totalOutlay = pos.totalCostUsd ? `$${escapeHtml(pos.totalCostUsd)}` : "—";
    const minimumAlignedPnl = pos.minimumAlignedPnlUsd === null || pos.minimumAlignedPnlUsd === undefined
      ? null
      : Number(pos.minimumAlignedPnlUsd);
    const minimumAlignedPnlLabel = minimumAlignedPnl === null || Number.isNaN(minimumAlignedPnl)
      ? "—"
      : formatUsd(minimumAlignedPnl);
    const minimumAlignedPnlColor = minimumAlignedPnl !== null && minimumAlignedPnl >= 0
      ? "var(--green)"
      : "var(--red)";
    const realizedProfitUsd = escapeHtml(pos.realizedProfitUsd || "0.00");
    const enteredAt = escapeHtml(formatTime(pos.enteredAt));
    const phaseLabel = escapeHtml(pos.phase ? pos.phase.replace("_", " ").toUpperCase() : "OPEN");
    const postFillActionValue = pos.postFillAction || "manual_reconciliation";
    const postFillAction = escapeHtml(postFillActionValue.replaceAll("_", " ").toUpperCase());
    const postFillReason = escapeHtml(pos.postFillReason || "No post-fill risk classification available.");
    const postFillRiskClass = postFillActionValue === "hold_or_exit_normally"
      ? "pos-risk-line"
      : "pos-error-line";
    const errorLine = pos.lastError
      ? `<div class="pos-error-line">ERROR: ${escapeHtml(pos.lastError)}</div>`
      : "";
    const settlementErrorLine = pos.settlementError
      ? `<div class="pos-error-line">SETTLEMENT RETRY: ${escapeHtml(pos.settlementError)}</div>`
      : "";

    html += `
      <div class="position-card ${cardClass}">
        <div class="pos-top-row">
          <div class="pos-id-group">
            <span class="pos-id">${positionId}</span>
            <span class="pos-pair">${duration} [${start} → ${end}]</span>
            <span class="phase-chip">${phaseLabel}</span>
          </div>
          <span class="hedge-badge ${badgeClass}">${badgeLabel}</span>
        </div>

        <div class="pos-legs-grid">
          <!-- Polymarket Leg -->
          <div class="leg-box">
            <div class="leg-head">
              <span>POLYMARKET LEG</span>
              <span class="leg-side ${polySideClass}">${polymarketOutcome}</span>
            </div>
            <div class="leg-row">
              <span>Contracts:</span>
              <b>${polymarketContracts}</b>
            </div>
            <div class="leg-row">
              <span>Cost Basis:</span>
              <b>$${polymarketCostUsd}</b>
            </div>
            <div class="leg-row">
              <span>Settled:</span>
              <b>${pos.polymarketSettled ? "✔ YES" : "⏳ PENDING"}</b>
            </div>
          </div>

          <!-- Jupiter Leg -->
          <div class="leg-box">
            <div class="leg-head">
              <span>JUPITER FORECAST LEG</span>
              <span class="leg-side ${jupSideClass}">${jupiterOutcome}</span>
            </div>
            <div class="leg-row">
              <span>Executed Contracts:</span>
              <b>${jupiterContracts}</b>
            </div>
            <div class="leg-row">
              <span>Quoted Contracts:</span>
              <b>${jupiterQuotedContracts}</b>
            </div>
            <div class="leg-row">
              <span>Cost Basis:</span>
              <b>$${jupiterCostUsd}</b>
            </div>
            <div class="leg-row">
              <span>Settled:</span>
              <b>${pos.jupiterSettled ? "✔ YES" : "⏳ PENDING"}</b>
            </div>
          </div>
        </div>

        <div class="pos-bottom-row">
          <div>Delta Skew: <b style="color:${skewColor}">${skewVal} contracts</b></div>
          <div>Total Capital: <b>${totalOutlay}</b></div>
          <div>Single-winner Floor: <b style="color:${minimumAlignedPnlColor}">${minimumAlignedPnlLabel}</b></div>
          <div>Poly-only Win PnL: <b>$${escapeHtml(pos.polymarketWinPnlUsd || "0")}</b></div>
          <div>Jup-only Win PnL: <b>$${escapeHtml(pos.jupiterWinPnlUsd || "0")}</b></div>
          <div>Both Win PnL: <b>$${escapeHtml(pos.bothWinPnlUsd || "0")}</b></div>
          <div>Both Lose PnL: <b style="color:var(--red)">$${escapeHtml(pos.bothLosePnlUsd || "0")}</b></div>
          <div>Max Modeled Loss: <b style="color:var(--red)">$${escapeHtml(pos.maximumModeledLossUsd || "0")}</b></div>
          <div>Post-fill Action: <b>${postFillAction}</b></div>
          <div>Jup Rent Reclaimed: <b>${pos.jupiterRentReclaimed ? `✔ ${escapeHtml(pos.jupiterRentReclaimedSol || "0")} SOL` : "⏳ PENDING"}</b></div>
          <div>Realized PnL: <b>$${realizedProfitUsd}</b></div>
          <div>Entered: <b>${enteredAt}</b></div>
        </div>

        ${errorLine}
        <div class="${postFillRiskClass}">FOUR-STATE RISK: ${postFillReason}</div>
        ${settlementErrorLine}
      </div>
    `;
  }

  el.positionsList.innerHTML = html;
}

function updateMarketBox(durKey, durData) {
  if (!durData) return;
  const is5m = durKey === "5m";

  const pEl = is5m ? el.phase5m : el.phase15m;
  const mEl = is5m ? el.msg5m : el.msg15m;
  const polyRefEl = is5m ? el.polyRef5m : el.polyRef15m;
  const jupRefEl = is5m ? el.jupRef5m : el.jupRef15m;
  const diffEl = is5m ? el.diff5m : el.diff15m;
  const polyUp = is5m ? el.polyUp5m : el.polyUp15m;
  const polyDown = is5m ? el.polyDown5m : el.polyDown15m;
  const jupUp = is5m ? el.jupUp5m : el.jupUp15m;
  const jupDown = is5m ? el.jupDown5m : el.jupDown15m;
  const edgeBox = is5m ? el.edgeBox5m : el.edgeBox15m;
  const rLabel = is5m ? el.routeLabel5m : el.routeLabel15m;
  const rEdge = is5m ? el.routeEdge5m : el.routeEdge15m;
  const rDetails = is5m ? el.routeDetails5m : el.routeDetails15m;

  pEl.textContent = durData.phase.toUpperCase();
  pEl.className = `phase-chip ${durData.phase}`;
  mEl.textContent = durData.message || "Scanning...";

  polyRefEl.textContent = durData.references?.polymarket?.priceUsd ? `$${Number(durData.references.polymarket.priceUsd).toFixed(2)}` : "—";
  jupRefEl.textContent = durData.references?.jupiter?.priceUsd ? `$${Number(durData.references.jupiter.priceUsd).toFixed(2)}` : "—";

  if (durData.references?.differenceUsd !== null && durData.references?.differenceUsd !== undefined) {
    const diff = Number(durData.references.differenceUsd);
    diffEl.textContent = `$${diff.toFixed(2)}`;
    const limit = Number(durData.references?.limitUsd);
    diffEl.style.color = Number.isFinite(limit) && diff < limit ? "var(--green)" : "var(--red)";
  } else {
    diffEl.textContent = "—";
    diffEl.style.color = "var(--text-bright)";
  }

  // Books
  const pb = durData.books?.polymarket;
  const jb = durData.books?.jupiter;

  polyUp.textContent = pb?.up ? `$${pb.up.priceUsd} (${pb.up.contracts})` : "—";
  polyDown.textContent = pb?.down ? `$${pb.down.priceUsd} (${pb.down.contracts})` : "—";
  jupUp.textContent = jb?.up ? `$${jb.up.priceUsd} (${jb.up.contracts})` : "—";
  jupDown.textContent = jb?.down ? `$${jb.down.priceUsd} (${jb.down.contracts})` : "—";

  // Route
  const route = durData.bestRoute;
  if (route) {
    rLabel.textContent = route.label;
    const edgeUsd = Number(route.edgeUsdPerContract);
    rEdge.textContent = `${Number.isFinite(edgeUsd) && edgeUsd > 0 ? "+" : ""}$${route.edgeUsdPerContract}/ct`;
    rDetails.textContent = `All-in: $${route.allInUsdPerContract} | Common size: ${route.commonContracts}`;
    if (route.feeAdjustedCandidate) {
      edgeBox.classList.add("candidate");
    } else {
      edgeBox.classList.remove("candidate");
    }
  } else {
    rLabel.textContent = "NO QUALIFIED ROUTE";
    rEdge.textContent = "—";
    rDetails.textContent = "All-in: — | Depth: —";
    edgeBox.classList.remove("candidate");
  }
}

function renderEvents() {
  el.eventCount.textContent = cachedEvents.length;

  const filtered = cachedEvents.filter((ev) => {
    if (currentFilter === "error") return ev.level === "error";
    if (currentFilter === "warn") return ev.level === "warn" || ev.level === "error";
    return true;
  });

  if (filtered.length === 0) {
    el.eventsContainer.innerHTML = `<div class="empty-state">NO ${escapeHtml(currentFilter.toUpperCase())} EVENTS LOGGED</div>`;
    return;
  }

  let html = "";
  for (const ev of filtered) {
    const levelClass = ev.level || "info";
    const codeTag = ev.code ? `<span class="event-code">${escapeHtml(ev.code)}</span>` : "";
    const durTag = ev.duration ? `[${escapeHtml(ev.duration)}]` : "";

    html += `
      <div class="event-entry ${levelClass}">
        <div class="event-head">
          <span>${durTag} ${codeTag}</span>
          <span>${escapeHtml(formatTime(ev.timestamp))}</span>
        </div>
        <div class="event-msg">${escapeHtml(ev.message)}</div>
      </div>
    `;
  }

  el.eventsContainer.innerHTML = html;
}

async function fetchStatus() {
  try {
    const res = await fetch(STATUS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Connection
    el.connPill.className = "conn-pill online";
    el.connLabel.textContent = `PORT ${scannerPort} ONLINE`;

    // Strategy & Mode
    const mode = data.strategy?.mode || (data.scanner?.readOnly ? "MONITOR" : "LIVE");
    el.modeTag.textContent = mode.toUpperCase() + (data.scanner?.readOnly ? " (READ ONLY)" : " TRADING");
    el.modeTag.className = mode === "live" ? "mode-tag live" : "mode-tag";

    if (data.strategy?.halted) {
      el.haltTag.style.display = "inline-block";
      el.haltTag.textContent = `HALTED: ${data.strategy.haltReason || "EXPOSURE ALERT"}`;
    } else {
      el.haltTag.style.display = "none";
    }

    // Top Metrics
    const pnl = Number(data.strategy?.realizedProfitUsd || 0);
    const legacyPnl = Number(data.strategy?.legacyUnverifiedRealizedProfitUsd || 0);
    el.topPnl.textContent = formatUsd(pnl);
    el.topPnl.className = pnl < 0 ? "m-val pnl-val negative" : "m-val pnl-val";
    el.topPnl.title = legacyPnl === 0
      ? "Confirmed-fill and verified-settlement accounting"
      : `${formatUsd(legacyPnl)} archived from legacy quote-derived accounting (not verified profit)`;

    el.topOpenPos.textContent = data.strategy?.openPositions || 0;

    const wb = data.strategy?.walletBalances;
    el.topPolyBal.textContent = wb?.polymarketCollateralUsd ? `$${Number(wb.polymarketCollateralUsd).toFixed(2)}` : "—";
    el.topJupBal.textContent = wb?.jupiterUsdcUsd ? `$${Number(wb.jupiterUsdcUsd).toFixed(2)}` : "—";
    el.topSolBal.textContent = wb?.jupiterSol ? `${Number(wb.jupiterSol).toFixed(3)} SOL` : "—";

    // Feeds
    const twap = data.feeds?.polymarketTwap;
    const spot = data.feeds?.jupiterSpot;
    if (twap) {
      const isOk = twap.status === "connected";
      el.polyFeedDot.className = isOk ? "dot-sm online" : "dot-sm";
      el.polyFeedStatus.textContent = twap.status.toUpperCase();
      el.polyFeedStatus.className = isOk ? "feed-stat online" : "feed-stat";
    }
    if (spot) {
      const isOk = spot.status === "connected";
      el.jupFeedDot.className = isOk ? "dot-sm online" : "dot-sm";
      el.jupFeedStatus.textContent = spot.status.toUpperCase();
      el.jupFeedStatus.className = isOk ? "feed-stat online" : "feed-stat";
    }

    // Positions
    renderPositions(data.strategy?.positions || [], data.strategy?.awaitingResolution || 0);

    // Markets (5m / 15m)
    if (data.durations) {
      updateMarketBox("5m", data.durations["5m"]);
      updateMarketBox("15m", data.durations["15m"]);
    }

    // Events
    if (data.events && Array.isArray(data.events)) {
      cachedEvents = data.events;
      renderEvents();
    }

    // Footer Last Action
    if (data.strategy?.lastAction) {
      el.lastActionText.textContent = data.strategy.lastAction;
      el.lastActionTime.textContent = formatTime(data.strategy.updatedAt || new Date().toISOString());
    }
  } catch (err) {
    el.connPill.className = "conn-pill offline";
    el.connLabel.textContent = "OFFLINE (ENGINE NOT DETECTED)";
  }
}

// Poll serially so a slow status response cannot create overlapping requests.
async function pollStatus() {
  await fetchStatus();
  setTimeout(pollStatus, 1000);
}

void pollStatus();
