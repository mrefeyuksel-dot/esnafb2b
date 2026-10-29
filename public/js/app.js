// EsnafB2B v6.0 frontend. All data comes from the Python API under /api.
'use strict';

const CODE_RE = /^EB2B-[A-Z2-9]{6}$/;
const COMMISSION_RATE = 0.015;
const MAX_BONUS_RATE = 21.5;

const state = {
    config: null,
    products: [],
    cart: {},
    appZoneId: null,
    appGrocerId: null,
    depotZoneId: null,
    depotOrders: [],
    confirmCode: null,
};

const $ = (id) => document.getElementById(id);

// --- Formatting & helpers ---

const numberFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const decimalFmt = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const moneyFmt = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtTL = (n) => `${numberFmt.format(n)} TL`;
const fmtTL2 = (n) => `${moneyFmt.format(n)} TL`;
const fmtPct = (n) => decimalFmt.format(n);

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    let data = null;
    try {
        data = await res.json();
    } catch {
        // Non-JSON error page.
    }
    if (!res.ok) {
        throw new Error(data?.error || `Sunucu hatası (${res.status})`);
    }
    return data;
}

function zoneById(id) {
    return state.config?.zones.find((z) => z.id === id);
}

// --- Toast ---

let toastTimer = null;

function showToast(title, message, isError = false) {
    const toast = $('toast');
    $('toastTitle').textContent = title;
    $('toastMessage').textContent = message;
    toast.classList.toggle('toast--error', isError);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function showError(err) {
    showToast('İşlem tamamlanamadı', err.message || String(err), true);
}

// --- Modals ---

let lastFocus = null;

function openModal(id) {
    lastFocus = document.activeElement;
    const modal = $(id);
    modal.hidden = false;
    modal.querySelector('input, button:not([data-close]), select')?.focus();
}

function closeModal(modal) {
    modal.hidden = true;
    if (modal.id === 'confirmModal') state.confirmCode = null;
    lastFocus?.focus?.();
}

document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) openModal(opener.dataset.open);

    const closer = e.target.closest('[data-close]');
    if (closer) closeModal(closer.closest('.modal'));

    if (e.target.classList.contains('modal')) closeModal(e.target);
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal:not([hidden])').forEach(closeModal);
});

// --- Views ---

const VIEWS = ['landing', 'bakkal', 'depo', 'uretici'];

function showView(name) {
    VIEWS.forEach((v) => { $(`view-${v}`).hidden = v !== name; });
    document.querySelectorAll('.tab').forEach((tab) => {
        tab.classList.toggle('is-active', tab.dataset.view === name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (name === 'depo') loadDepot().catch(showError);
    if (name === 'uretici') loadManufacturer().catch(showError);
}

document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) showView(btn.dataset.view);
});

// --- Config: cost table, hero zones, selects ---

async function loadConfig() {
    state.config = await api('/api/config');
    renderSaving();
    renderCostTable();
    renderHeroZones();
    renderZoneSelects();
    updateCalculators();
    renderCart();
}

function renderSaving() {
    const { totals } = state.config;
    document.querySelectorAll('[data-bind="saving"]').forEach((el) => {
        el.textContent = fmtPct(totals.saving_pct);
    });
    $('costTotalEsnaf').textContent = fmtPct(totals.esnafb2b);
    $('costTotalEsnafCell').textContent = fmtPct(totals.esnafb2b);
}

function signedPct(n) {
    if (n === 0) return '%0,0';
    return `${n < 0 ? '−' : ''}%${fmtPct(Math.abs(n))}`;
}

function renderCostTable() {
    $('costTableBody').innerHTML = state.config.cost_model.map((row) => {
        const trad = Number(row.traditional_pct);
        const esnaf = Number(row.esnafb2b_pct);
        const esnafClass = esnaf > 0 ? 'num-plus' : 'num-new';
        return `
            <tr>
                <td><strong>${esc(row.label)}</strong></td>
                <td class="${trad > 0 ? 'num-old' : 'muted'}">${signedPct(trad)}</td>
                <td class="${esnafClass}">${signedPct(esnaf)}</td>
                <td class="muted">${esc(row.note)}</td>
            </tr>`;
    }).join('');
}

function renderHeroZones() {
    $('heroZones').innerHTML = state.config.zones.map((z) => {
        const pct = Math.round((z.boxes / z.quota_boxes) * 100);
        const full = z.boxes >= z.quota_boxes;
        return `
            <li class="zone-item${full ? ' zone-item--full' : ''}">
                <div>
                    <div class="zone-item__name">${z.id}. ${esc(z.name)}</div>
                    <div class="zone-item__meta">Depo: ${esc(z.depot_name)} · hedef ${z.member_target} üye bakkal</div>
                </div>
                <div class="zone-item__count">
                    ${numberFmt.format(z.boxes)} / ${numberFmt.format(z.quota_boxes)} koli
                    <small>${full ? 'Sevkiyata hazır' : `Kota %${pct}`}</small>
                </div>
            </li>`;
    }).join('');
}

function renderZoneSelects() {
    const options = state.config.zones.map((z) =>
        `<option value="${z.id}">Hücre ${z.id}: ${esc(z.name)} (Depo: ${esc(z.depot_name)}, ${z.distance_m} m)</option>`
    ).join('');
    const depotOptions = state.config.zones.map((z) =>
        `<option value="${z.id}">${esc(z.depot_name)} (Hücre ${z.id})</option>`
    ).join('');

    state.appZoneId ??= state.config.zones[0]?.id;
    state.depotZoneId ??= state.config.zones[0]?.id;

    $('appZoneSelect').innerHTML = options;
    $('appZoneSelect').value = state.appZoneId;
    $('depotZoneSelect').innerHTML = depotOptions;
    $('depotZoneSelect').value = state.depotZoneId;
    renderGrocerSelect();
}

function renderGrocerSelect() {
    const members = state.config.grocers.filter((g) => g.zone_id === state.appZoneId && !g.is_depot);
    if (!members.some((g) => g.id === state.appGrocerId)) {
        state.appGrocerId = members[0]?.id ?? null;
    }
    $('appGrocerSelect').innerHTML = members.map((g) =>
        `<option value="${g.id}">${esc(g.name)} (Üye #${g.member_no})</option>`
    ).join('');
    $('appGrocerSelect').value = state.appGrocerId ?? '';
}

// --- Calculators ---

function discountForVolume(boxes, baseRate) {
    if (boxes > 1000) {
        const extra = Math.min(MAX_BONUS_RATE - baseRate, Math.log10(boxes / 1000) * 5.5);
        return { rate: +(baseRate + extra).toFixed(1), status: '1.000 koli üzeri hacim iskontosu uygulanıyor' };
    }
    if (boxes < 1000) {
        return { rate: +(baseRate - 1.2).toFixed(1), status: `Tır kotası dolmadı; 1.000 kolide oran %${fmtPct(baseRate)}` };
    }
    return { rate: baseRate, status: 'Standart tır kotası' };
}

function updateCalculators() {
    const baseRate = state.config?.totals.saving_pct ?? 19.3;

    const spend = Number($('calcMonthlySpend').value);
    const boxes = Number($('calcBoxVolume').value);
    const { rate, status } = discountForVolume(boxes, baseRate);
    const monthly = Math.round(spend * (rate / 100));

    $('calcMonthlySpendLabel').textContent = fmtTL(spend);
    $('calcBoxVolumeLabel').textContent = `${numberFmt.format(boxes)} koli`;
    $('calcDiscountRate').textContent = `%${fmtPct(rate)}`;
    $('calcBonusStatus').textContent = status;
    $('calcMonthlySaving').textContent = fmtTL(monthly);
    $('calcAnnualSaving').textContent = fmtTL(monthly * 12);

    const depotVolume = Number($('depotVolumeSlider').value);
    $('depotVolumeLabel').textContent = fmtTL(depotVolume);
    $('depotMonthlyEarning').textContent = fmtTL(Math.round(depotVolume * COMMISSION_RATE));
}

['calcMonthlySpend', 'calcBoxVolume', 'depotVolumeSlider'].forEach((id) => {
    $(id).addEventListener('input', updateCalculators);
});

// --- Üye Bakkal app ---

async function loadProducts() {
    state.products = await api('/api/products');
    renderCatalog();
}

function renderCatalog() {
    $('appCatalog').innerHTML = state.products.map((p) => `
        <div class="product">
            <div>
                <span class="product__brand">${esc(p.brand)}</span>
                <h4 class="product__name">${esc(p.name)}</h4>
                <div class="product__prices">
                    <s>${fmtTL(p.list_price)}</s>
                    <strong>${fmtTL(p.pool_price)} / koli</strong>
                </div>
            </div>
            <div class="stepper">
                <button type="button" data-product="${esc(p.id)}" data-delta="-1" aria-label="${esc(p.name)} azalt">−</button>
                <output aria-live="polite">${state.cart[p.id] || 0}</output>
                <button type="button" data-product="${esc(p.id)}" data-delta="1" aria-label="${esc(p.name)} artır">+</button>
            </div>
        </div>`
    ).join('') || '<p class="muted">Ürün bulunamadı.</p>';
}

$('appCatalog').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-product]');
    if (!btn) return;
    const id = btn.dataset.product;
    const next = Math.min(200, Math.max(0, (state.cart[id] || 0) + Number(btn.dataset.delta)));
    if (next === 0) delete state.cart[id];
    else state.cart[id] = next;
    renderCatalog();
    renderCart();
});

function cartTotals() {
    let boxes = 0;
    let list = 0;
    let pool = 0;
    for (const p of state.products) {
        const qty = state.cart[p.id] || 0;
        boxes += qty;
        list += qty * p.list_price;
        pool += qty * p.pool_price;
    }
    return { boxes, list, pool };
}

function renderCart() {
    const { boxes, list, pool } = cartTotals();
    $('appCartBoxes').textContent = `${boxes} koli`;
    $('appCartSavings').textContent = fmtTL(list - pool);
    $('appCartOldTotal').textContent = fmtTL(list);
    $('appCartNewTotal').textContent = fmtTL(pool);
    $('navCartCount').textContent = boxes;
    $('btnPlaceOrder').disabled = boxes === 0 || !state.appGrocerId;

    const zone = zoneById(state.appZoneId);
    if (!zone) return;
    const projected = zone.boxes + boxes;
    const pct = Math.min(100, Math.round((projected / zone.quota_boxes) * 100));
    const remaining = Math.max(0, zone.quota_boxes - projected);

    $('quotaTitle').textContent = `Hücre ${zone.id} tır kotası`;
    $('quotaCount').textContent = `${numberFmt.format(projected)} / ${numberFmt.format(zone.quota_boxes)} koli (%${pct})`;
    $('quotaBar').style.width = `${pct}%`;
    $('quotaNote').textContent = remaining === 0
        ? 'Tır kotası doldu; hücre sevkiyata hazır.'
        : `Tır kotasının dolmasına ${numberFmt.format(remaining)} koli kaldı.`;
}

$('appZoneSelect').addEventListener('change', (e) => {
    state.appZoneId = Number(e.target.value);
    renderGrocerSelect();
    renderCart();
});

$('appGrocerSelect').addEventListener('change', (e) => {
    state.appGrocerId = Number(e.target.value);
});

$('btnPlaceOrder').addEventListener('click', async () => {
    const items = Object.entries(state.cart).map(([product_id, qty]) => ({ product_id, qty }));
    if (!items.length) return;

    const btn = $('btnPlaceOrder');
    btn.disabled = true;
    try {
        const order = await api('/api/orders', {
            method: 'POST',
            body: JSON.stringify({ grocer_id: state.appGrocerId, zone_id: state.appZoneId, items }),
        });
        state.cart = {};
        renderPass(order);
        renderCatalog();
        await loadConfig();
        loadDepot().catch(() => {});
        showToast('Sipariş oluşturuldu', `${order.code} kodlu ${order.boxes} kolilik sipariş ${zoneById(order.zone_id)?.depot_name ?? 'Depo Bakkal'} teslimat listesine eklendi.`);
    } catch (err) {
        showError(err);
    } finally {
        renderCart();
    }
});

function renderPass(order) {
    const zone = zoneById(order.zone_id);
    $('passQr').src = order.qr_url;
    $('passCode').textContent = order.code;
    $('passDepot').textContent = zone ? `Teslim noktası: ${zone.depot_name} (${zone.distance_m} m)` : '';
    $('passGrocer').textContent = `${order.grocer} (#${order.member_no})`;
    $('passBoxes').textContent = `${order.boxes} koli`;
    $('passTotal').textContent = fmtTL(order.total_pool);
    const saved = order.total_list - order.total_pool;
    const savedPct = order.total_list ? (saved / order.total_list) * 100 : 0;
    $('passSaved').textContent = `${fmtTL(saved)} (%${fmtPct(savedPct)})`;
    $('passEmpty').hidden = true;
    $('passFilled').hidden = false;
}

// --- Depo Bakkal panel ---

async function loadDepot() {
    if (!state.depotZoneId) return;
    state.depotOrders = await api(`/api/orders?zone_id=${state.depotZoneId}`);
    renderDepot();
}

function renderDepot() {
    const orders = state.depotOrders.filter((o) => o.status !== 'cancelled');
    const waiting = orders.filter((o) => o.status === 'waiting');
    const volume = orders.reduce((sum, o) => sum + o.total_pool, 0);
    const commission = orders.filter((o) => o.status === 'delivered').reduce((sum, o) => sum + o.commission, 0);

    $('kpiVolume').textContent = fmtTL(volume);
    $('kpiCommission').textContent = fmtTL2(commission);
    $('kpiPending').textContent = `${waiting.length} sipariş`;
    $('navPendingCount').textContent = waiting.length;

    $('depotQueueBody').innerHTML = state.depotOrders.map((o) => {
        const status = o.status === 'waiting'
            ? '<span class="status status--waiting">Teslim alınmayı bekliyor</span>'
            : o.status === 'delivered'
                ? '<span class="status status--delivered">Teslim edildi</span>'
                : '<span class="status status--cancelled">İptal</span>';
        const action = o.status === 'waiting'
            ? `<button class="btn btn--emerald btn--sm" type="button" data-deliver="${esc(o.code)}">
                   <svg class="icon"><use href="#i-qr-code"/></svg> Teslim et
               </button>`
            : '<span class="small muted">Komisyon kaydedildi</span>';
        return `
            <tr>
                <td class="code">${esc(o.code)}</td>
                <td><strong>${esc(o.grocer)}</strong> <span class="muted">#${esc(o.member_no)}</span></td>
                <td>${o.boxes} koli</td>
                <td>${fmtTL(o.total_pool)}</td>
                <td class="num-new">+${fmtTL2(o.commission)}</td>
                <td>${status}</td>
                <td class="t-right">${action}</td>
            </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">Bu hücrede henüz sipariş yok.</td></tr>';
}

$('depotZoneSelect').addEventListener('change', (e) => {
    state.depotZoneId = Number(e.target.value);
    loadDepot().catch(showError);
});

$('depotQueueBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-deliver]');
    if (btn) openConfirm(btn.dataset.deliver);
});

$('codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('codeInput').value.trim().toUpperCase();
    if (!CODE_RE.test(code)) {
        showToast('Geçersiz kod', 'Teslimat kodu EB2B-XXXXXX biçiminde olmalıdır.', true);
        return;
    }
    openConfirm(code);
});

async function openConfirm(code) {
    let order;
    try {
        order = await api(`/api/orders/${encodeURIComponent(code)}`);
    } catch (err) {
        showError(err);
        return;
    }

    if (order.zone_id !== state.depotZoneId) {
        state.depotZoneId = order.zone_id;
        $('depotZoneSelect').value = order.zone_id;
        loadDepot().catch(showError);
    }

    state.confirmCode = order.code;
    $('confirmCode').textContent = order.code;
    $('confirmGrocer').textContent = `${order.grocer} (#${order.member_no})`;
    $('confirmDetails').textContent =
        `${order.boxes} koli · ${fmtTL(order.total_pool)} · Depo komisyonu +${fmtTL2(order.commission)} (%1,5)`;

    const deliverable = order.status === 'waiting';
    $('confirmWarning').hidden = deliverable;
    $('confirmWarning').textContent = deliverable ? '' : 'Bu sipariş daha önce teslim edilmiş veya iptal edilmiş.';
    $('btnConfirmDeliver').disabled = !deliverable;
    openModal('confirmModal');
}

$('btnConfirmDeliver').addEventListener('click', async () => {
    const code = state.confirmCode;
    if (!code) return;
    const btn = $('btnConfirmDeliver');
    btn.disabled = true;
    try {
        const order = await api(`/api/orders/${encodeURIComponent(code)}/deliver`, { method: 'POST' });
        closeModal($('confirmModal'));
        $('codeInput').value = '';
        await loadDepot();
        showToast('Teslimat onaylandı', `${order.grocer} kolilerini teslim aldı. +${fmtTL2(order.commission)} komisyon kaydedildi.`);
    } catch (err) {
        btn.disabled = false;
        showError(err);
    }
});

// --- Üretici panel ---

async function loadManufacturer() {
    const brand = $('brandFilter').value;
    const data = await api(`/api/manufacturer${brand ? `?brand=${encodeURIComponent(brand)}` : ''}`);
    const totalBoxes = data.zones.reduce((sum, z) => sum + z.boxes, 0);
    const brandBoxes = data.zones.reduce((sum, z) => sum + z.brand_boxes, 0);

    $('mfgTotalBoxes').textContent = `${numberFmt.format(totalBoxes)} koli`;
    $('mfgBrandBoxes').textContent = brand ? `${numberFmt.format(brandBoxes)} koli` : '–';

    $('mfgZones').innerHTML = data.zones.map((z) => `
        <article class="zone-card">
            <div class="zone-card__top">
                <div>
                    <span class="zone-card__label">Hücre ${z.id}: ${esc(z.name)}</span>
                    <h4>Depo: ${esc(z.depot_name)}</h4>
                    <p class="small muted">Hedef ${z.member_target} üye bakkal · ${z.distance_m} m ortalama mesafe</p>
                </div>
                <span class="zone-card__count">${numberFmt.format(z.boxes)} / ${numberFmt.format(z.quota_boxes)} koli</span>
            </div>
            <div>
                <div class="zone-card__row">
                    <span>Tır kotası doluluğu</span>
                    <strong>%${z.fill_pct}</strong>
                </div>
                <div class="bar bar--light"><div class="bar__fill bar__fill--indigo" style="width:${z.fill_pct}%"></div></div>
            </div>
            <div class="zone-card__foot">
                ${brand
                    ? `${esc(brand)}: <strong>${numberFmt.format(z.brand_boxes)} koli</strong> (uygulama siparişleri)`
                    : `En çok sipariş edilen: <strong>${z.top_brands.length ? z.top_brands.map(esc).join(', ') : '—'}</strong>`}
            </div>
        </article>`
    ).join('');
}

$('brandFilter').addEventListener('change', () => loadManufacturer().catch(showError));

// --- Depot application ---

$('depotApplyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    data.storage_m2 = Number(data.storage_m2);
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
        await api('/api/depot-applications', { method: 'POST', body: JSON.stringify(data) });
        form.reset();
        closeModal($('depotApplyModal'));
        showToast('Başvurunuz alındı', 'Ekibimiz depo alanınızı değerlendirmek için sizinle iletişime geçecek.');
    } catch (err) {
        showError(err);
    } finally {
        submit.disabled = false;
    }
});

// --- Startup ---

async function init() {
    updateCalculators();
    try {
        await Promise.all([loadConfig(), loadProducts()]);
        renderCart();
        await loadDepot();
    } catch (err) {
        $('heroZones').innerHTML = '<li class="muted">Veriler yüklenemedi. Lütfen sayfayı yenileyin.</li>';
        $('costTableBody').innerHTML = '<tr><td colspan="4" class="muted">Veriler yüklenemedi.</td></tr>';
        showError(err);
        return;
    }

    // QR deep link: /?teslim=EB2B-XXXXXX opens the depot panel with the order selected.
    const params = new URLSearchParams(window.location.search);
    const code = params.get('teslim')?.trim().toUpperCase();
    if (code) {
        history.replaceState(null, '', window.location.pathname);
        showView('depo');
        if (CODE_RE.test(code)) openConfirm(code);
        else showToast('Geçersiz kod', 'QR kodundaki teslimat kodu okunamadı.', true);
    }
}

init();
