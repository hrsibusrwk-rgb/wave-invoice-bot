const { Telegraf } = require('telegraf');
const http = require('http'); // built-in http module to satisfy Render's port requirement

const wave = require('./wave');

// ==================== CONFIG ====================
// Recommended: move these to Render Environment Variables, and rotate them since they were exposed once.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8957889878:AAGsOwGMnv8dNiSa22Bsl1VbYCAgdzohbNU";

// If keyword matches more customers than this, don't filter per-customer, just scan the whole table/date range
const MAX_MATCHED_CUSTOMERS_FOR_FILTER = 20;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ====================================================================
// PART 1: original #find / #resend invoice-search feature (logic unchanged, now calls wave.js)
// ====================================================================

function normalizeKeyword(kw) {
    const yeMatch = kw.match(/^ye(\d{2}|\d{4})$/);
    if (yeMatch) {
        const digits = yeMatch[1];
        return digits.length === 2 ? `20${digits}` : digits;
    }
    const rmMatch = kw.match(/^rm(\d+(\.\d+)?)$/);
    if (rmMatch) return rmMatch[1];
    return kw;
}

// Takes the RAW keyword (before normalizeKeyword strips any "ye"/"rm" prefix) so it can tell a real
// year apart from a bare number that's just part of a company's name.
function keywordToDateRange(rawKw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawKw)) {
        return { invoiceDateStart: rawKw, invoiceDateEnd: rawKw };
    }
    if (/^\d{4}-\d{2}$/.test(rawKw)) {
        const [y, m] = rawKw.split('-').map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        return { invoiceDateStart: `${rawKw}-01`, invoiceDateEnd: `${rawKw}-${String(lastDay).padStart(2, '0')}` };
    }
    // Year — only when explicitly marked with "YE" (year-end), e.g. YE2023 or YE23.
    // A bare 4-digit number on its own (e.g. "2023") is NOT treated as a year, because it can just as
    // easily be part of a customer's actual name (e.g. a company literally called "CJ 2023") — treating
    // it as a date would wrongly narrow the search at the API level and hide real matches.
    const yeMatch = rawKw.match(/^ye(\d{2}|\d{4})$/);
    if (yeMatch) {
        const digits = yeMatch[1];
        const year = digits.length === 2 ? `20${digits}` : digits;
        return { invoiceDateStart: `${year}-01-01`, invoiceDateEnd: `${year}-12-31` };
    }
    return null;
}

async function searchWaveInvoice(keywordInput) {
    const rawKeywords = keywordInput.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const keywords = rawKeywords.map(normalizeKeyword);

    let dateRange = null;
    for (const rawKw of rawKeywords) {
        const range = keywordToDateRange(rawKw);
        if (range) {
            dateRange = range;
            break;
        }
    }
    let allMatched = [];

    const promises = wave.WAVE_ACCOUNTS.map(async (acc) => {
        const customers = await wave.getCustomersForAccount(acc);
        const matchingCustomerIds = customers
            .filter(c => {
                const nameLower = String(c.name || '').toLowerCase();
                return keywords.some(kw => kw.length >= 2 && nameLower.includes(kw));
            })
            .map(c => c.id);

        let edges;
        if (matchingCustomerIds.length > 0 && matchingCustomerIds.length <= MAX_MATCHED_CUSTOMERS_FOR_FILTER) {
            const perCustomerEdges = await Promise.all(
                matchingCustomerIds.map(cid => wave.fetchAllInvoicesForAccount(acc, { customerId: cid, ...(dateRange || {}) }))
            );
            edges = perCustomerEdges.flat();
        } else if (dateRange) {
            edges = await wave.fetchAllInvoicesForAccount(acc, dateRange);
        } else {
            edges = await wave.fetchAllInvoicesForAccount(acc);
        }

        const matched = [];
        for (let edge of edges) {
            const inv = edge.node;
            const invNum = String(inv.invoiceNumber || '').toLowerCase();
            const custName = inv.customer && inv.customer.name ? inv.customer.name.toLowerCase() : '';
            const amount = (inv.amountDue && inv.amountDue.value !== undefined && inv.amountDue.value !== null)
                ? String(inv.amountDue.value).toLowerCase()
                : '';
            const status = String(inv.status || '').toLowerCase();
            const invoiceDate = String(inv.invoiceDate || '').toLowerCase();

            const payments = inv.payments || [];
            const paymentDatesStr = payments.map(p => String(p.paymentDate || '').toLowerCase()).join(' ');
            const paymentMethodsStr = payments.map(p => String(p.paymentMethod || '').toLowerCase()).join(' ');
            const paymentAmountsStr = payments.map(p => String(p.amount || '').toLowerCase()).join(' ');

            const combinedFields = `${invNum} ${custName} ${amount} ${status} ${invoiceDate} ${paymentDatesStr} ${paymentMethodsStr} ${paymentAmountsStr}`;
            const isMatchAll = keywords.every(kw => combinedFields.includes(kw));

            if (isMatchAll) {
                const paymentSummary = payments.length > 0
                    ? payments.map(p => `${p.paymentDate || 'N/A'} · ${p.paymentMethod || 'N/A'} · RM${p.amount || '0'}`).join('\n   ')
                    : 'No payment recorded yet';

                matched.push({
                    accountName: acc.name,
                    invoiceNumber: inv.invoiceNumber,
                    invoiceDate: inv.invoiceDate,
                    paymentSummary: paymentSummary,
                    status: inv.status,
                    customerName: inv.customer ? inv.customer.name : 'N/A',
                    amount: amount,
                    viewUrl: inv.viewUrl
                });
            }
        }
        return matched;
    });

    const resultsArrays = await Promise.all(promises);
    for (const arr of resultsArrays) {
        allMatched.push(...arr);
    }

    return allMatched;
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// When a Wave API call fails outright (e.g. HTTP 400), axios only gives a generic
// "Request failed with status code 400" in err.message — the actually useful detail
// is in err.response.data. This pulls that out so replies show the real reason.
function describeAxiosError(err) {
    if (err && err.response && err.response.data !== undefined) {
        try {
            return JSON.stringify(err.response.data, null, 2).slice(0, 3000);
        } catch (e) {
            // fall through
        }
    }
    return err && err.message ? err.message : String(err);
}

const TELEGRAM_SAFE_LENGTH = 3500;
const MAX_RESULTS_TO_SHOW = 150;

async function replyWithResults(ctx, keyword, results) {
    const totalCount = results.length;
    const shown = results.slice(0, MAX_RESULTS_TO_SHOW);

    let chunks = [];
    let current = `🎉 <b>Found ${totalCount} invoice(s) matching "${escapeHtml(keyword)}":</b>\n`;

    for (const inv of shown) {
        const block = `\n-------------------\n` +
                      `🏢 <b>Account:</b> ${escapeHtml(inv.accountName)}\n` +
                      `📄 <b>Invoice No:</b> #${escapeHtml(inv.invoiceNumber)}\n` +
                      `🏷️ <b>Status:</b> ${escapeHtml(inv.status)}\n` +
                      `📅 <b>Invoice Date:</b> ${escapeHtml(inv.invoiceDate)}\n` +
                      `👤 <b>Customer:</b> ${escapeHtml(inv.customerName)}\n` +
                      `💰 <b>Amount Due:</b> RM${escapeHtml(inv.amount)}\n` +
                      `💵 <b>Payment(s):</b> ${escapeHtml(inv.paymentSummary)}\n` +
                      `🔗 <b>View Link:</b> ${escapeHtml(inv.viewUrl)}\n`;

        if ((current + block).length > TELEGRAM_SAFE_LENGTH) {
            chunks.push(current);
            current = block;
        } else {
            current += block;
        }
    }
    if (current) chunks.push(current);

    if (totalCount > MAX_RESULTS_TO_SHOW) {
        const notice = `\n⚠️ Only showing the first ${MAX_RESULTS_TO_SHOW} of ${totalCount} matches. Please use a more specific keyword (e.g. add an invoice number or date) to narrow it down.`;
        if ((chunks[chunks.length - 1].length + notice.length) <= TELEGRAM_SAFE_LENGTH) {
            chunks[chunks.length - 1] += notice;
        } else {
            chunks.push(notice.trim());
        }
    }

    for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: 'HTML', disable_web_page_preview: true });
    }
}

// ====================================================================
// PART 2: new feature — #invoice (create) / #edit (update)
// Completely free, no external AI/OCR service: paste the Excel table as plain text.
//
// Usage (on a computer, select the range to invoice in Excel, Ctrl+C, then Ctrl+V into the
// Telegram message box, with the command on the first line, and send it all as one message):
//
//   #invoice SCC
//   Company Name:	Duolus Techologies
//   Item	Description	QTY	Price	Amount
//   Payment on Behalf	EPF Aug26	1	1,236.00	1,236.00
//   ...
//
//   #edit SCC 4475
//   Company Name:	Duolus Techologies
//   Item	Description	QTY	Price	Amount
//   ...
//
// For safety, there is deliberately NO "delete invoice" command anywhere here — not in Telegram,
// not internally.
// ====================================================================

// Each chat keeps at most one "pending" action awaiting confirmation
const pendingActions = new Map(); // chatId -> {...}
const PENDING_TTL_MS = 15 * 60 * 1000; // expires after 15 minutes if not confirmed

function clearStalePending(chatId) {
    const p = pendingActions.get(chatId);
    if (p && (Date.now() - p.createdAt) > PENDING_TTL_MS) {
        pendingActions.delete(chatId);
        return null;
    }
    return p || null;
}

// Normalize a company name (strip common suffixes/punctuation) for fuzzy matching
function normalizeCompanyName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\(.*?\)/g, ' ')
        .replace(/[.,]/g, ' ')
        .replace(/\bsdn\s*bhd\b/g, ' ')
        .replace(/\bberhad\b/g, ' ')
        .replace(/\bltd\b/g, ' ')
        .replace(/\bpte\b/g, ' ')
        .replace(/\binc\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreNameMatch(a, b) {
    const na = normalizeCompanyName(a);
    const nb = normalizeCompanyName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.includes(nb) || nb.includes(na)) return 0.9;
    const ta = new Set(na.split(' ').filter(Boolean));
    const tb = new Set(nb.split(' ').filter(Boolean));
    let common = 0;
    for (const t of ta) if (tb.has(t)) common++;
    const union = new Set([...ta, ...tb]).size;
    return union ? common / union : 0;
}

function findCustomerCandidates(customers, companyName, limit = 3) {
    return customers
        .map(c => ({ customer: c, score: scoreNameMatch(c.name, companyName) }))
        .filter(x => x.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

// Match each parsed item name against existing Wave products/services; unmatched ones are flagged "to be created"
function planProductMatches(items, existingProducts) {
    const usedNewNames = new Map(); // if two rows in the same batch share an item name, only create it once
    return items.map(it => {
        const norm = String(it.item || '').trim().toLowerCase();
        const found = existingProducts.find(p => String(p.name || '').trim().toLowerCase() === norm);
        if (found) {
            return { ...it, productId: found.id, isNewProduct: false };
        }
        if (usedNewNames.has(norm)) {
            return { ...it, productId: usedNewNames.get(norm), isNewProduct: true, pendingCreate: true };
        }
        return { ...it, productId: null, isNewProduct: true, pendingCreate: true };
    });
}

function formatItemsPreview(items) {
    return items.map((it, idx) => {
        const flag = it.isNewProduct ? ' 🆕 new service item' : '';
        const amount = (it.qty * it.price).toFixed(2);
        return `${idx + 1}. <b>${escapeHtml(it.item)}</b>${flag}\n   ${escapeHtml(it.description)} · qty ${it.qty} × RM${it.price} = RM${amount}`;
    }).join('\n');
}

function totalOf(items) {
    return items.reduce((sum, it) => sum + (Number(it.qty) * Number(it.price)), 0).toFixed(2);
}

// Actually create any missing products and fill in productId (same name only created once)
async function resolveProductIds(acc, items) {
    const created = new Map(); // normalizedName -> id
    const resolved = [];
    for (const it of items) {
        if (it.productId) {
            resolved.push(it);
            continue;
        }
        const norm = String(it.item || '').trim().toLowerCase();
        if (created.has(norm)) {
            resolved.push({ ...it, productId: created.get(norm) });
            continue;
        }
        const result = await wave.createProduct(acc, it.item, it.price);
        const payload = result?.data?.productCreate;
        if (!payload?.didSucceed || !payload?.product?.id) {
            throw new Error(`Failed to create service item "${it.item}": ` + JSON.stringify(payload?.inputErrors || result.errors || result));
        }
        created.set(norm, payload.product.id);
        resolved.push({ ...it, productId: payload.product.id });
    }
    wave.invalidateProductCache(acc);
    return resolved;
}

// Parse the pasted Excel content. Three formats are auto-detected so the user doesn't need to
// know which one they have:
//   1. Desktop paste: one line per row, cells separated by real tab characters.
//   2. Mobile paste: the keyboard/clipboard turns tabs into line breaks, so each cell is on its own line.
//   3. Browser paste (e.g. Telegram Web): tabs get collapsed into plain spaces, so a whole row ends up
//      as one space-separated line with no reliable delimiter between the Item and Description cells.
//      For that case, known product/service names already in Wave are used to figure out where the
//      Item name ends and the Description begins.
function parseInvoicePaste(bodyText, knownItemNames = []) {
    const rawLines = String(bodyText || '').split(/\r?\n/);
    const hasTabs = rawLines.some(l => l.includes('\t'));
    if (hasTabs) return parseTabSeparatedPaste(rawLines);

    const looksLikeSpaceColumns = rawLines.some(l => /^item\s+description\s+qty\b/i.test(l.trim()));
    if (looksLikeSpaceColumns) return parseSpaceColumnPaste(rawLines, knownItemNames);

    return parseOneCellPerLinePaste(rawLines);
}

// Format 1: desktop paste, one line with several tab-separated cells
function parseTabSeparatedPaste(lines) {
    let companyName = null;
    const items = [];

    for (const rawLine of lines) {
        if (!rawLine.trim()) continue;

        const cells = rawLine.split('\t').map(c => c.trim());
        const firstCellLower = (cells[0] || '').toLowerCase();

        if (firstCellLower.startsWith('company name')) {
            let name = cells[1] || '';
            if (!name) {
                const afterColon = rawLine.split(':').slice(1).join(':').trim();
                name = afterColon.split('\t')[0].trim();
            }
            companyName = name;
            continue;
        }

        if (firstCellLower === 'item') {
            continue; // header row, skip
        }

        if (cells.length < 4) continue; // incomplete row (blank line, total row with only 1-2 cells), skip

        const item = cells[0];
        const description = cells[1];
        const qtyRaw = cells[2];
        const priceRaw = cells[3];

        if (!item || !qtyRaw || !priceRaw) continue;

        const qty = parseFloat(qtyRaw.replace(/,/g, ''));
        const price = parseFloat(String(priceRaw).replace(/[^0-9.\-]/g, ''));

        if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

        items.push({ item, description, qty, price });
    }

    return { companyName, items };
}

// Format 2: mobile paste, tabs got turned into line breaks, so each cell is on its own line
function parseOneCellPerLinePaste(lines) {
    const tokens = lines.map(l => l.trim()).filter(l => l.length > 0);

    let companyName = null;
    const rest = [];
    let i = 0;
    while (i < tokens.length) {
        const t = tokens[i];
        const cnMatch = t.match(/^company name\s*:?\s*(.*)$/i);
        if (cnMatch) {
            if (cnMatch[1]) {
                companyName = cnMatch[1].trim();
                i += 1;
            } else {
                companyName = (tokens[i + 1] || '').trim();
                i += 2;
            }
            continue;
        }
        rest.push(t);
        i += 1;
    }

    // Find the "Item" header, then see how many known column labels follow (Description/QTY/Price/Amount)
    // to figure out how many lines each data row spans.
    const headerLabels = ['item', 'description', 'qty', 'price', 'amount'];
    const headerStart = rest.findIndex(t => t.toLowerCase() === 'item');
    let columnCount = 4;
    let dataStart = 0;

    if (headerStart !== -1) {
        let j = headerStart;
        let matched = 0;
        while (j < rest.length && matched < headerLabels.length &&
            rest[j].toLowerCase().replace(/\s+/g, '') === headerLabels[matched]) {
            j += 1;
            matched += 1;
        }
        columnCount = Math.max(matched, 4);
        dataStart = j;
    }

    const dataTokens = rest.slice(dataStart);
    const items = [];
    for (let k = 0; k + 3 < dataTokens.length; k += columnCount) {
        const group = dataTokens.slice(k, k + columnCount);
        if (group.length < 4) break;

        const item = group[0];
        const description = group[1];
        const qty = parseFloat(String(group[2]).replace(/,/g, ''));
        const price = parseFloat(String(group[3]).replace(/[^0-9.\-]/g, ''));

        if (!item || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
        items.push({ item, description, qty, price });
    }

    return { companyName, items };
}

// Format 3: browser paste (e.g. Telegram Web) where tabs got collapsed into spaces, so each row is
// "Item Description QTY Price Amount" all on one line with no reliable delimiter between Item and
// Description. We pull the trailing QTY/Price/Amount numbers off the end of the line (those are always
// there), then match the start of what's left against known existing Wave product/service names to
// split Item from Description. If nothing matches (e.g. a brand-new item never invoiced before), the
// whole remaining text is used as the Item name — still works, just doesn't split out a Description
// (and will match cleanly next time, once that item name exists in Wave).
function parseSpaceColumnPaste(lines, knownItemNames) {
    let companyName = null;
    const items = [];
    const sortedNames = [...new Set((knownItemNames || []).filter(Boolean))].sort((a, b) => b.length - a.length);

    // Greedy (.+) naturally backtracks to the rightmost point where the rest of the line is exactly
    // "QTY PRICE AMOUNT", which is what isolates the trailing numeric columns from the item/description text.
    const rowPattern = /^(.+)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s*$/;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const cnMatch = line.match(/^company name\s*:?\s*(.*)$/i);
        if (cnMatch) {
            companyName = cnMatch[1].trim();
            continue;
        }

        if (/^item\s+description\s+qty\b/i.test(line)) continue; // header row, skip

        const m = line.match(rowPattern);
        if (!m) continue;

        const rest = m[1].trim();
        const qty = parseFloat(m[2].replace(/,/g, ''));
        const price = parseFloat(m[3].replace(/,/g, ''));

        if (!rest || !Number.isFinite(qty) || !Number.isFinite(price)) continue;

        let item = rest;
        let description = '';
        const foundName = sortedNames.find(n =>
            rest.toLowerCase() === n.toLowerCase() || rest.toLowerCase().startsWith(n.toLowerCase() + ' ')
        );
        if (foundName) {
            item = foundName;
            description = rest.slice(foundName.length).trim();
        }

        items.push({ item, description, qty, price });
    }

    return { companyName, items };
}

// Parse the command on the first line (#invoice SCC / #edit SCC 4475); the rest is the pasted table
function parseCommandAndBody(fullText) {
    const lines = String(fullText || '').split(/\r?\n/);
    const firstLine = (lines[0] || '').trim();
    const body = lines.slice(1).join('\n');

    let m = firstLine.match(/^#invoice\s+(\S+)\s*$/i);
    if (m) return { action: 'invoice', accountCode: m[1], body };

    // Accept "#edit SCC 4502" (code and number separated by a space).
    // Accept "#edit SCC-02127" / "#edit 4502" (a single token) WITHOUT guessing the account from it —
    // Wave's own invoice-number prefix does not necessarily match our SCC/SB account codes (an invoice
    // under the "SB" account can still be numbered "SCC-...", since that prefix is Wave's own setting,
    // not ours). When only one token is given, accountCode is left null and the caller searches every
    // account for that invoice number instead of assuming which one it belongs to.
    m = firstLine.match(/^#edit\s+(.+)$/i);
    if (m) {
        const rest = m[1].trim();
        const parts = rest.split(/\s+/);

        if (parts.length >= 2) {
            return { action: 'edit', accountCode: parts[0], invoiceNumber: parts.slice(1).join(' '), body };
        }

        return { action: 'edit', accountCode: null, invoiceNumber: parts[0] || '', body };
    }

    if (/^#invoice\b/i.test(firstLine) || /^#edit\b/i.test(firstLine)) {
        return { action: 'usage_error' };
    }
    return null;
}

const USAGE_TEXT =
    "⚠️ Wrong format. Correct usage (on a computer, copy the range to invoice from Excel, paste it below the command, and send it all as one message):\n\n" +
    "<code>#invoice SCC\n" +
    "Company Name:\tXXX\n" +
    "Item\tDescription\tQTY\tPrice\tAmount\n" +
    "Service Item\tDetails\t1\t100.00\t100.00</code>\n\n" +
    "To edit an invoice, use <code>#edit SCC 4475</code> (account code + invoice number), then paste the table the same way.";

async function handleInvoiceOrEditCommand(ctx, parsed) {
    if (parsed.action === 'usage_error') {
        await ctx.reply(USAGE_TEXT, { parse_mode: 'HTML' });
        return;
    }

    const chatId = ctx.chat.id;

    if (parsed.action === 'invoice') {
        const acc = wave.findAccountByCode(parsed.accountCode);
        if (!acc) {
            await ctx.reply(`⚠️ Unknown account code "${escapeHtml(parsed.accountCode)}". Available codes: ` + wave.WAVE_ACCOUNTS.map(a => `${a.code} (${a.name})`).join(', '));
            return;
        }

        // Products are fetched before parsing (not just for later product-matching) because the
        // browser-paste format (Format 3) needs known item names to split Item from Description.
        let products;
        try {
            products = await wave.getProductsForAccount(acc);
        } catch (err) {
            await ctx.reply('❌ Failed to load the Wave product/service list: ' + describeAxiosError(err));
            return;
        }

        const extracted = parseInvoicePaste(parsed.body, products.map(p => p.name));

        if (!extracted.items || extracted.items.length === 0) {
            await ctx.reply('❌ Could not parse any valid rows. Make sure you copied and pasted the full table from Excel, including the header row.\n\n' + USAGE_TEXT, { parse_mode: 'HTML' });
            return;
        }

        if (!extracted.companyName) {
            await ctx.reply('❌ Could not find a "Company Name" line. Please make sure the pasted content includes it.');
            return;
        }

        let customers;
        try {
            customers = await wave.getCustomersForAccount(acc);
        } catch (err) {
            await ctx.reply('❌ Failed to load the Wave customer list: ' + describeAxiosError(err));
            return;
        }
        const candidates = findCustomerCandidates(customers, extracted.companyName);

        pendingActions.set(chatId, {
            mode: 'create',
            acc,
            extracted,
            candidates,
            createdAt: Date.now()
        });

        let msg = `📋 Parsed from your paste:\nCompany: <b>${escapeHtml(extracted.companyName)}</b>\nAccount: ${escapeHtml(acc.name)}\nLine items: ${extracted.items.length}\n\n`;
        msg += 'Which Wave customer should this invoice be billed to? (reply with a number)\n';
        candidates.forEach((c, idx) => {
            msg += `${idx + 1}. ${escapeHtml(c.customer.name)} (${(c.score * 100).toFixed(0)}% match)\n`;
        });
        msg += `0. None of these — create a new customer "${escapeHtml(extracted.companyName)}"\n\nReply <code>#cancel</code> to cancel this.`;

        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
    }

    if (parsed.action === 'edit') {
        let acc = null;
        let existingInvoice = null;

        if (parsed.accountCode) {
            // Account explicitly given (e.g. "#edit SB 4502") — look up only in that one.
            acc = wave.findAccountByCode(parsed.accountCode);
            if (!acc) {
                await ctx.reply(`⚠️ Unknown account code "${escapeHtml(parsed.accountCode)}". Available codes: ` + wave.WAVE_ACCOUNTS.map(a => `${a.code} (${a.name})`).join(', '));
                return;
            }
            try {
                existingInvoice = await wave.findInvoiceByNumber(acc, parsed.invoiceNumber);
            } catch (err) {
                await ctx.reply('❌ Failed to look up the invoice: ' + describeAxiosError(err));
                return;
            }
        } else {
            // No account given (e.g. "#edit SCC-02127") — an invoice's number prefix doesn't reliably
            // tell us which of our accounts it's in, so check every account instead of guessing.
            const matches = [];
            for (const a of wave.WAVE_ACCOUNTS) {
                try {
                    const inv = await wave.findInvoiceByNumber(a, parsed.invoiceNumber);
                    if (inv) matches.push({ account: a, invoice: inv });
                } catch (err) {
                    await ctx.reply(`❌ Failed to look up the invoice in ${a.name}: ` + describeAxiosError(err));
                    return;
                }
            }
            if (matches.length > 1) {
                await ctx.reply('⚠️ Found an invoice with that number in more than one account. Please specify which one:\n' +
                    matches.map(m => `<code>#edit ${escapeHtml(m.account.code)} ${escapeHtml(parsed.invoiceNumber)}</code> (${escapeHtml(m.account.name)})`).join('\n'),
                    { parse_mode: 'HTML' });
                return;
            }
            if (matches.length === 1) {
                acc = matches[0].account;
                existingInvoice = matches[0].invoice;
            }
        }

        if (!existingInvoice) {
            const where = parsed.accountCode ? `in ${acc.name}` : 'in any account';
            await ctx.reply(`❌ Couldn't find an invoice with a number containing "${escapeHtml(parsed.invoiceNumber)}" ${where}. Double-check the number, or specify the account explicitly, e.g. <code>#edit SB ${escapeHtml(parsed.invoiceNumber)}</code>.`, { parse_mode: 'HTML' });
            return;
        }

        let products;
        try {
            products = await wave.getProductsForAccount(acc);
        } catch (err) {
            await ctx.reply('❌ Failed to load the Wave product/service list: ' + describeAxiosError(err));
            return;
        }

        const extracted = parseInvoicePaste(parsed.body, products.map(p => p.name));

        if (!extracted.items || extracted.items.length === 0) {
            await ctx.reply('❌ Could not parse any valid rows. Make sure you copied and pasted the full table from Excel, including the header row.\n\n' + USAGE_TEXT, { parse_mode: 'HTML' });
            return;
        }

        const plannedItems = planProductMatches(extracted.items, products);

        pendingActions.set(chatId, {
            mode: 'edit',
            acc,
            extracted,
            existingInvoice,
            plannedItems,
            createdAt: Date.now()
        });

        let msg = `📋 About to update invoice <b>#${escapeHtml(existingInvoice.invoiceNumber)}</b> (customer: ${escapeHtml(existingInvoice.customer?.name || 'N/A')})\n\n`;
        msg += 'New line items:\n' + formatItemsPreview(plannedItems) + `\n\nTotal: RM${totalOf(plannedItems)}\n\n`;
        msg += '⚠️ Confirming will replace this invoice\'s existing line items entirely with the ones above.\nReply <code>#confirm</code> to proceed, or <code>#cancel</code> to abort.';

        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
    }
}

async function handleCustomerChoice(ctx, pending, choiceText) {
    const chatId = ctx.chat.id;
    const num = Number(choiceText.trim());
    if (!Number.isInteger(num) || num < 0 || num > pending.candidates.length) {
        await ctx.reply(`Please reply with a number from 0 to ${pending.candidates.length}, or reply #cancel to cancel.`);
        return;
    }

    let chosenCustomerId = null;
    let chosenCustomerName = null;
    if (num === 0) {
        try {
            const result = await wave.createCustomer(pending.acc, pending.extracted.companyName);
            const payload = result?.data?.customerCreate;
            if (!payload?.didSucceed || !payload?.customer?.id) {
                await ctx.reply('❌ Failed to create the customer: ' + JSON.stringify(payload?.inputErrors || result.errors || result));
                return;
            }
            chosenCustomerId = payload.customer.id;
            chosenCustomerName = payload.customer.name;
            wave.invalidateCustomerCache(pending.acc);
        } catch (err) {
            await ctx.reply('❌ Failed to create the customer: ' + describeAxiosError(err));
            return;
        }
    } else {
        chosenCustomerId = pending.candidates[num - 1].customer.id;
        chosenCustomerName = pending.candidates[num - 1].customer.name;
    }

    let products;
    try {
        products = await wave.getProductsForAccount(pending.acc);
    } catch (err) {
        await ctx.reply('❌ Failed to load the Wave product/service list: ' + describeAxiosError(err));
        return;
    }
    const plannedItems = planProductMatches(pending.extracted.items, products);

    pendingActions.set(chatId, {
        ...pending,
        step: 'confirm',
        chosenCustomerId,
        chosenCustomerName,
        plannedItems,
        createdAt: Date.now()
    });

    let msg = `👤 Customer: <b>${escapeHtml(chosenCustomerName)}</b>\n\nLine items:\n${formatItemsPreview(plannedItems)}\n\nTotal: RM${totalOf(plannedItems)}\n\n`;
    msg += 'The invoice will be created as "confirmed but not sent" (Saved) — it will NOT be emailed to the customer automatically; the link will be posted here.\n';
    msg += 'Reply <code>#confirm</code> to create it, or <code>#cancel</code> to abort.';
    await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function handleConfirm(ctx, pending) {
    const chatId = ctx.chat.id;

    if (pending.mode === 'create') {
        if (!pending.plannedItems) {
            await ctx.reply('⚠️ No customer selected yet — please reply with a number to choose one first.');
            return;
        }
        await ctx.reply('⏳ Creating the invoice...');
        try {
            const itemsWithIds = await resolveProductIds(pending.acc, pending.plannedItems);
            const result = await wave.createInvoice(pending.acc, {
                customerId: pending.chosenCustomerId,
                items: itemsWithIds,
                status: 'SAVED'
            });
            const payload = result?.data?.invoiceCreate;
            if (!payload?.didSucceed || !payload?.invoice) {
                await ctx.reply('❌ Wave rejected this request. Raw error below (you can use it to fix createInvoice in wave.js):\n' +
                    JSON.stringify(payload?.inputErrors || result.errors || result, null, 2).slice(0, 3500));
                return;
            }
            await ctx.reply(
                `✅ Invoice created!\n📄 Invoice #: #${escapeHtml(payload.invoice.invoiceNumber)}\n🔗 Link: ${escapeHtml(payload.invoice.viewUrl)}`,
                { disable_web_page_preview: true }
            );
        } catch (err) {
            console.error('[Invoice] create failed:', err.response?.data || err.message);
            await ctx.reply('❌ Failed to create the invoice: ' + describeAxiosError(err));
        } finally {
            pendingActions.delete(chatId);
        }
        return;
    }

    if (pending.mode === 'edit') {
        await ctx.reply('⏳ Updating the invoice...');
        try {
            const itemsWithIds = await resolveProductIds(pending.acc, pending.plannedItems);
            const result = await wave.patchInvoiceItems(pending.acc, pending.existingInvoice.id, itemsWithIds);
            const payload = result?.data?.invoicePatch;
            if (!payload?.didSucceed || !payload?.invoice) {
                await ctx.reply('❌ Wave rejected this request. Raw error below (you can use it to fix patchInvoiceItems in wave.js):\n' +
                    JSON.stringify(payload?.inputErrors || result.errors || result, null, 2).slice(0, 3500));
                return;
            }
            await ctx.reply(
                `✅ Invoice updated!\n📄 Invoice #: #${escapeHtml(payload.invoice.invoiceNumber)}\n🔗 Link: ${escapeHtml(payload.invoice.viewUrl)}`,
                { disable_web_page_preview: true }
            );
        } catch (err) {
            console.error('[Invoice] update failed:', err.response?.data || err.message);
            await ctx.reply('❌ Failed to update the invoice: ' + describeAxiosError(err));
        } finally {
            pendingActions.delete(chatId);
        }
        return;
    }
}

// ====================================================================
// Text command entry point
// ====================================================================

bot.start((ctx) => {
    ctx.reply("👋 Hello! Multi-Account Wave Assistant is ready.\n\n" +
        "Search invoices: #find <keyword>\n" +
        "Create an invoice: #invoice SCC (or SB), then paste the Excel table below it\n" +
        "Edit an invoice: #edit SCC <invoice number>, then paste the Excel table below it");
});

// If someone sends a photo out of habit, remind them to paste text instead (no image handling — free plan uses no images)
bot.on('photo', async (ctx) => {
    const caption = (ctx.message.caption || '').trim();
    if (/^#invoice\b/i.test(caption) || /^#edit\b/i.test(caption)) {
        await ctx.reply('This feature no longer uses screenshots: please copy the range to invoice from Excel on a computer and paste it as text instead (not as an image).\n\n' + USAGE_TEXT, { parse_mode: 'HTML' });
    }
});

bot.on('text', async (ctx) => {
    const messageText = ctx.message.text;
    const chatId = ctx.chat.id;
    const trimmed = messageText.trim();

    // ---- Check if this chat has a pending create/edit action awaiting confirmation ----
    const pending = clearStalePending(chatId);
    if (pending) {
        if (/^#cancel$/i.test(trimmed)) {
            pendingActions.delete(chatId);
            await ctx.reply('Cancelled.');
            return;
        }
        if (pending.mode === 'create' && !pending.step) {
            // still waiting for the customer choice
            await handleCustomerChoice(ctx, pending, trimmed);
            return;
        }
        if (/^#confirm$/i.test(trimmed)) {
            await handleConfirm(ctx, pending);
            return;
        }
        // there's a pending action but this message is neither a number choice nor #confirm/#cancel/another command
        if (!/^#(find|resend|schema|invoice|edit)\b/i.test(trimmed)) {
            await ctx.reply('There is a pending action awaiting confirmation. Reply #confirm to proceed, #cancel to abort, or paste the table again.');
            return;
        }
    }

    // ---- New feature: #invoice / #edit (paste Excel table content) ----
    const parsedCommand = parseCommandAndBody(messageText);
    if (parsedCommand) {
        await handleInvoiceOrEditCommand(ctx, parsedCommand);
        return;
    }

    // ---- Temporary debug command: inspect a Wave GraphQL type's fields (remove once schema is verified) ----
    if (trimmed.startsWith('#schema')) {
        const parts = trimmed.split(/\s+/);
        const typeName = parts[parts.length - 1];
        const acc = wave.WAVE_ACCOUNTS[0];
        try {
            const info = await wave.introspectType(acc, typeName);
            await ctx.reply('<pre>' + escapeHtml(info) + '</pre>', { parse_mode: 'HTML' });
        } catch (err) {
            await ctx.reply('Query failed: ' + err.message);
        }
        return;
    }

    // ---- Original invoice-search feature ----
    if (trimmed.startsWith('#resend') || trimmed.startsWith('#find')) {
        const keyword = trimmed.replace('#resend', '').replace('#find', '').trim();

        if (!keyword) {
            await ctx.reply("⚠️ Please provide a keyword. Example: <code>#resend abc 2026-06</code>", { parse_mode: 'HTML' });
            return;
        }

        await ctx.reply(`🔍 Searching across all independent Wave accounts for: "${keyword}"...`);

        const results = await searchWaveInvoice(keyword);

        if (results.length === 0) {
            await ctx.reply(`❌ No invoice records found matching all conditions for "${keyword}".`);
        } else {
            await replyWithResults(ctx, keyword, results);
        }
    }
});

bot.launch();
console.log('✅ Telegram Bot successfully started and online!');

// Start a tiny HTTP server to satisfy Render's port requirement
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive and running!');
}).listen(PORT, () => {
    console.log(`HTTP server is listening on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
