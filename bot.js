const { Telegraf } = require('telegraf');
const http = require('http'); // 引入内置的 http 模块来满足 Render 端口要求

const wave = require('./wave');

// ==================== 配置区 ====================
// ⚠️ 建议挪去 Render 的 Environment Variables，并在暴露过后重新生成一个新 token。
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8957889878:AAGsOwGMnv8dNiSa22Bsl1VbYCAgdzohbNU";

// 关键字匹配到的客户数超过这个数，就不逐个按客户筛了，直接整表/按日期扫
const MAX_MATCHED_CUSTOMERS_FOR_FILTER = 20;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ====================================================================
// 第一部分：原本就有的 #find / #resend 查发票功能（逻辑不变，只是改成调用 wave.js）
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

function keywordToDateRange(kw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(kw)) {
        return { invoiceDateStart: kw, invoiceDateEnd: kw };
    }
    if (/^\d{4}-\d{2}$/.test(kw)) {
        const [y, m] = kw.split('-').map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        return { invoiceDateStart: `${kw}-01`, invoiceDateEnd: `${kw}-${String(lastDay).padStart(2, '0')}` };
    }
    if (/^\d{4}$/.test(kw)) {
        return { invoiceDateStart: `${kw}-01-01`, invoiceDateEnd: `${kw}-12-31` };
    }
    return null;
}

async function searchWaveInvoice(keywordInput) {
    const keywords = keywordInput.toLowerCase().trim().split(/\s+/).filter(Boolean).map(normalizeKeyword);

    let dateRange = null;
    for (const kw of keywords) {
        const range = keywordToDateRange(kw);
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
// 第二部分：新功能 —— #invoice 开票 / #edit 改票
// 完全免费，不调用任何外部 AI/OCR 服务：直接从 Excel 复制表格粘贴成文字。
//
// 用法（在电脑上，从 Excel 选取要开票的范围，Ctrl+C 复制，到 Telegram 输入框 Ctrl+V 贴上，
// 在最前面加一行指令，整段一起发送）：
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
// 出于安全考虑，这里完全没有实现任何"删除发票"的指令 —— 不管是 Telegram 指令还是内部函数，都没有。
// ====================================================================

// 每个聊天窗口同一时间只保留一个"待确认"的操作
const pendingActions = new Map(); // chatId -> {...}
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 分钟没确认就失效

function clearStalePending(chatId) {
    const p = pendingActions.get(chatId);
    if (p && (Date.now() - p.createdAt) > PENDING_TTL_MS) {
        pendingActions.delete(chatId);
        return null;
    }
    return p || null;
}

// 把公司名归一化，去掉常见的后缀/标点，方便模糊匹配
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

// 把识别出来的 item 名字对到已存在的 Wave 产品/服务，对不上的标记成"待新建"
function planProductMatches(items, existingProducts) {
    const usedNewNames = new Map(); // 同一批里如果有两行 item 名字一样，只建一次
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
        const flag = it.isNewProduct ? ' 🆕新建服务项目' : '';
        const amount = (it.qty * it.price).toFixed(2);
        return `${idx + 1}. <b>${escapeHtml(it.item)}</b>${flag}\n   ${escapeHtml(it.description)} · 数量 ${it.qty} × RM${it.price} = RM${amount}`;
    }).join('\n');
}

function totalOf(items) {
    return items.reduce((sum, it) => sum + (Number(it.qty) * Number(it.price)), 0).toFixed(2);
}

// 实际创建缺失的产品，把 productId 补齐（同名的只建一次）
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
        const result = await wave.createProduct(acc, it.item);
        const payload = result?.data?.productCreate;
        if (!payload?.didSucceed || !payload?.product?.id) {
            throw new Error(`新建服务项目 "${it.item}" 失败：` + JSON.stringify(payload?.inputErrors || result.errors || result));
        }
        created.set(norm, payload.product.id);
        resolved.push({ ...it, productId: payload.product.id });
    }
    wave.invalidateProductCache(acc);
    return resolved;
}

// 解析从 Excel 粘贴过来的文字（Tab 分隔）
function parseInvoicePaste(bodyText) {
    const lines = String(bodyText || '').split(/\r?\n/);
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
            continue; // 表头行，跳过
        }

        if (cells.length < 4) continue; // 数据不完整（比如空行、合计行只有一两格），跳过

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

// 解析消息第一行的指令（#invoice SCC / #edit SCC 4475），剩下的行当作贴过来的表格内容
function parseCommandAndBody(fullText) {
    const lines = String(fullText || '').split(/\r?\n/);
    const firstLine = (lines[0] || '').trim();

    let m = firstLine.match(/^#invoice\s+(\S+)\s*$/i);
    if (m) return { action: 'invoice', accountCode: m[1], body: lines.slice(1).join('\n') };

    m = firstLine.match(/^#edit\s+(\S+)\s+(\S+)\s*$/i);
    if (m) return { action: 'edit', accountCode: m[1], invoiceNumber: m[2], body: lines.slice(1).join('\n') };

    if (/^#invoice\b/i.test(firstLine) || /^#edit\b/i.test(firstLine)) {
        return { action: 'usage_error' };
    }
    return null;
}

const USAGE_TEXT =
    "⚠️ 格式不对。正确用法是（在电脑上从 Excel 复制要开票的范围，粘贴在指令下面，整段一起发送）：\n\n" +
    "<code>#invoice SCC\n" +
    "Company Name:\tXXX\n" +
    "Item\tDescription\tQTY\tPrice\tAmount\n" +
    "服务项目\t说明\t1\t100.00\t100.00</code>\n\n" +
    "改发票用 <code>#edit SCC 4475</code>（账号代号 + 发票号码），下面同样贴表格内容。";

async function handleInvoiceOrEditCommand(ctx, parsed) {
    if (parsed.action === 'usage_error') {
        await ctx.reply(USAGE_TEXT, { parse_mode: 'HTML' });
        return;
    }

    const acc = wave.findAccountByCode(parsed.accountCode);
    if (!acc) {
        await ctx.reply(`⚠️ 没有找到账号代号 "${escapeHtml(parsed.accountCode)}"。可用代号：` + wave.WAVE_ACCOUNTS.map(a => `${a.code} (${a.name})`).join('，'));
        return;
    }

    const chatId = ctx.chat.id;
    const extracted = parseInvoicePaste(parsed.body);

    if (!extracted.items || extracted.items.length === 0) {
        await ctx.reply('❌ 没有解析到任何一行有效数据，检查一下是不是完整从 Excel 复制粘贴过来的（要包含 Tab 分隔，不要手动加空格）。\n\n' + USAGE_TEXT, { parse_mode: 'HTML' });
        return;
    }

    if (parsed.action === 'invoice') {
        if (!extracted.companyName) {
            await ctx.reply('❌ 没有找到 "Company Name" 那一行，请确认粘贴的内容里有这一行。');
            return;
        }

        let customers;
        try {
            customers = await wave.getCustomersForAccount(acc);
        } catch (err) {
            await ctx.reply('❌ 读取 Wave 客户列表失败：' + err.message);
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

        let msg = `📋 读到的资料：\n公司名：<b>${escapeHtml(extracted.companyName)}</b>\n账号：${escapeHtml(acc.name)}\n项目行数：${extracted.items.length}\n\n`;
        msg += '请选择这张发票要 Bill To 哪个 Wave 客户（回复数字）：\n';
        candidates.forEach((c, idx) => {
            msg += `${idx + 1}. ${escapeHtml(c.customer.name)}（相似度 ${(c.score * 100).toFixed(0)}%）\n`;
        });
        msg += `0. 都不是，新建客户 "${escapeHtml(extracted.companyName)}"\n\n回复 <code>#cancel</code> 可以取消这次操作。`;

        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
    }

    if (parsed.action === 'edit') {
        let existingInvoice;
        try {
            existingInvoice = await wave.findInvoiceByNumber(acc, parsed.invoiceNumber);
        } catch (err) {
            await ctx.reply('❌ 查找发票失败：' + err.message);
            return;
        }
        if (!existingInvoice) {
            await ctx.reply(`❌ 在 ${acc.name} 找不到发票号码包含 "${escapeHtml(parsed.invoiceNumber)}" 的发票，确认一下号码对不对。`);
            return;
        }

        let products;
        try {
            products = await wave.getProductsForAccount(acc);
        } catch (err) {
            await ctx.reply('❌ 读取 Wave 服务项目列表失败：' + err.message);
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

        let msg = `📋 准备更新发票 <b>#${escapeHtml(existingInvoice.invoiceNumber)}</b>（客户：${escapeHtml(existingInvoice.customer?.name || 'N/A')}）\n\n`;
        msg += '新的项目内容：\n' + formatItemsPreview(plannedItems) + `\n\n合计：RM${totalOf(plannedItems)}\n\n`;
        msg += '⚠️ 确认后会用上面这些项目整个覆盖这张发票原本的项目。\n回复 <code>#confirm</code> 确认，或 <code>#cancel</code> 取消。';

        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
    }
}

async function handleCustomerChoice(ctx, pending, choiceText) {
    const chatId = ctx.chat.id;
    const num = Number(choiceText.trim());
    if (!Number.isInteger(num) || num < 0 || num > pending.candidates.length) {
        await ctx.reply(`请回复 0 到 ${pending.candidates.length} 之间的数字，或者回复 #cancel 取消。`);
        return;
    }

    let chosenCustomerId = null;
    let chosenCustomerName = null;
    if (num === 0) {
        try {
            const result = await wave.createCustomer(pending.acc, pending.extracted.companyName);
            const payload = result?.data?.customerCreate;
            if (!payload?.didSucceed || !payload?.customer?.id) {
                await ctx.reply('❌ 新建客户失败：' + JSON.stringify(payload?.inputErrors || result.errors || result));
                return;
            }
            chosenCustomerId = payload.customer.id;
            chosenCustomerName = payload.customer.name;
            wave.invalidateCustomerCache(pending.acc);
        } catch (err) {
            await ctx.reply('❌ 新建客户失败：' + err.message);
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
        await ctx.reply('❌ 读取 Wave 服务项目列表失败：' + err.message);
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

    let msg = `👤 客户：<b>${escapeHtml(chosenCustomerName)}</b>\n\n项目内容：\n${formatItemsPreview(plannedItems)}\n\n合计：RM${totalOf(plannedItems)}\n\n`;
    msg += '发票会以"已确认但不寄出"（Saved）状态建立，不会自动 email 给客户，链接会发在这里。\n';
    msg += '回复 <code>#confirm</code> 确认建立，或 <code>#cancel</code> 取消。';
    await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function handleConfirm(ctx, pending) {
    const chatId = ctx.chat.id;

    if (pending.mode === 'create') {
        if (!pending.plannedItems) {
            await ctx.reply('⚠️ 还没选客户，请先回复数字选择客户。');
            return;
        }
        await ctx.reply('⏳ 正在建立发票...');
        try {
            const itemsWithIds = await resolveProductIds(pending.acc, pending.plannedItems);
            const result = await wave.createInvoice(pending.acc, {
                customerId: pending.chosenCustomerId,
                items: itemsWithIds,
                status: 'SAVED'
            });
            const payload = result?.data?.invoiceCreate;
            if (!payload?.didSucceed || !payload?.invoice) {
                await ctx.reply('❌ Wave 拒绝了这次建票请求，返回原始错误如下（可以直接照着改 wave.js 里的 createInvoice）：\n' +
                    JSON.stringify(payload?.inputErrors || result.errors || result, null, 2).slice(0, 3500));
                return;
            }
            await ctx.reply(
                `✅ 发票建立成功！\n📄 发票号：#${escapeHtml(payload.invoice.invoiceNumber)}\n🔗 下载/查看链接：${escapeHtml(payload.invoice.viewUrl)}`,
                { disable_web_page_preview: true }
            );
        } catch (err) {
            console.error('[Invoice] 建票失败:', err.response?.data || err.message);
            await ctx.reply('❌ 建票失败：' + err.message);
        } finally {
            pendingActions.delete(chatId);
        }
        return;
    }

    if (pending.mode === 'edit') {
        await ctx.reply('⏳ 正在更新发票...');
        try {
            const itemsWithIds = await resolveProductIds(pending.acc, pending.plannedItems);
            const result = await wave.patchInvoiceItems(pending.acc, pending.existingInvoice.id, itemsWithIds);
            const payload = result?.data?.invoicePatch;
            if (!payload?.didSucceed || !payload?.invoice) {
                await ctx.reply('❌ Wave 拒绝了这次更新请求，返回原始错误如下（可以直接照着改 wave.js 里的 patchInvoiceItems）：\n' +
                    JSON.stringify(payload?.inputErrors || result.errors || result, null, 2).slice(0, 3500));
                return;
            }
            await ctx.reply(
                `✅ 发票更新成功！\n📄 发票号：#${escapeHtml(payload.invoice.invoiceNumber)}\n🔗 下载/查看链接：${escapeHtml(payload.invoice.viewUrl)}`,
                { disable_web_page_preview: true }
            );
        } catch (err) {
            console.error('[Invoice] 改票失败:', err.response?.data || err.message);
            await ctx.reply('❌ 更新失败：' + err.message);
        } finally {
            pendingActions.delete(chatId);
        }
        return;
    }
}

// ====================================================================
// 文字指令统一入口
// ====================================================================

bot.start((ctx) => {
    ctx.reply("👋 Hello! Multi-Account Wave Assistant is ready.\n\n" +
        "查发票：#find <关键字>\n" +
        "开发票：#invoice SCC（或 SB），下面贴 Excel 表格内容\n" +
        "改发票：#edit SCC <发票号码>，下面贴 Excel 表格内容");
});

// 有人图省事直接传图片，提醒改成复制粘贴文字（不处理图片，完全免费方案不用图片）
bot.on('photo', async (ctx) => {
    const caption = (ctx.message.caption || '').trim();
    if (/^#invoice\b/i.test(caption) || /^#edit\b/i.test(caption)) {
        await ctx.reply('这个功能改成不用截图了：请在电脑上从 Excel 复制要开票的范围，直接贴成文字发过来（不是发图片）。' + '\n\n' + USAGE_TEXT, { parse_mode: 'HTML' });
    }
});

bot.on('text', async (ctx) => {
    const messageText = ctx.message.text;
    const chatId = ctx.chat.id;
    const trimmed = messageText.trim();

    // ---- 先看看这个聊天窗口是不是有正在等确认的开票/改票操作 ----
    const pending = clearStalePending(chatId);
    if (pending) {
        if (/^#cancel$/i.test(trimmed)) {
            pendingActions.delete(chatId);
            await ctx.reply('已取消。');
            return;
        }
        if (pending.mode === 'create' && !pending.step) {
            // 还在等客户选择
            await handleCustomerChoice(ctx, pending, trimmed);
            return;
        }
        if (/^#confirm$/i.test(trimmed)) {
            await handleConfirm(ctx, pending);
            return;
        }
        // 有 pending 但发来的既不是数字选择也不是 #confirm/#cancel，且不是别的指令，提示一下
        if (!/^#(find|resend|schema|invoice|edit)\b/i.test(trimmed)) {
            await ctx.reply('目前有一个操作在等你确认，回复 #confirm 确认、#cancel 取消，或者重新贴一次表格内容。');
            return;
        }
    }

    // ---- 新功能：#invoice / #edit（贴 Excel 表格内容） ----
    const parsedCommand = parseCommandAndBody(messageText);
    if (parsedCommand) {
        await handleInvoiceOrEditCommand(ctx, parsedCommand);
        return;
    }

    // ---- 临时调试指令：查 Wave 某个类型的字段（正式核对完 schema 后可以删掉这段） ----
    if (trimmed.startsWith('#schema')) {
        const parts = trimmed.split(/\s+/);
        const typeName = parts[parts.length - 1];
        const acc = wave.WAVE_ACCOUNTS[0];
        try {
            const info = await wave.introspectType(acc, typeName);
            await ctx.reply('<pre>' + escapeHtml(info) + '</pre>', { parse_mode: 'HTML' });
        } catch (err) {
            await ctx.reply('查询失败：' + err.message);
        }
        return;
    }

    // ---- 原本的查发票功能 ----
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

// 启动微型 HTTP 服务器满足 Render 端口要求
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive and running!');
}).listen(PORT, () => {
    console.log(`HTTP server is listening on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
