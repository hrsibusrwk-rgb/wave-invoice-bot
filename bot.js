const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http'); // 引入内置的 http 模块来满足 Render 端口要求

// ==================== 配置区 ====================
const TELEGRAM_BOT_TOKEN = "8957889878:AAGsOwGMnv8dNiSa22Bsl1VbYCAgdzohbNU";
const WAVE_GRAPHQL_URL = "https://gql.waveapps.com/graphql/public";

// 多账号列表
const WAVE_ACCOUNTS = [
    {
        name: "Solid Capital Consulting",
        businessId: "QnVzaW5lc3M6MmI5OGRiYjYtYWQ4My00OWM5LWIwZTEtYTUzNGJmYTk1MjBk",
        token: "sNkMtPQuJipbBEhkxtCBL2ydBAYF2l"
    },
    {
        name: "Solid Capital Consulting Sdn. Bhd.",
        businessId: "QnVzaW5lc3M6NTY5NmNiMTYtZmE2Yi00NjEzLWFmNDMtYmZjMjNmNDA4NmY3",
        token: "CuF67Ugju7HR0w4UU9x41p9IeKpYdj"
    }
];

// 每页拉多少条记录
const PAGE_SIZE = 50;
// 单次翻页最多翻多少页，防止数据超多时无限翻页
// 1000 页 * 50 张/页 = 最多抓 50000 条
const MAX_PAGES_PER_ACCOUNT = 1000;
// 拿到第 1 页、确认总页数之后，剩下的页数几个一批并发抓取，加快速度
// Wave API 有限速，并发太高会被 429/RATE_LIMITED 拒绝，2 是比较稳的数字
const FETCH_CONCURRENCY = 2;
// 单页被限速时最多重试几次，超过就放弃这一页
const MAX_RETRIES_PER_PAGE = 5;
// 关键字匹配到的客户数超过这个数，就不逐个按客户筛了（大概率不是在搜具体某个客户），直接整表/按日期扫
const MAX_MATCHED_CUSTOMERS_FOR_FILTER = 20;
// 客户列表缓存多久（客户变动不频繁，不用每次搜索都重新拉一次）
const CUSTOMER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// invoices 支持 customerId / invoiceDateStart / invoiceDateEnd 等参数做服务器端筛选，
// 不传（undefined -> null）就等于不筛，跟以前整表扫的行为一样
const INVOICES_QUERY = `
query($businessId: ID!, $page: Int!, $pageSize: Int!, $customerId: ID, $invoiceDateStart: Date, $invoiceDateEnd: Date) {
    business(id: $businessId) {
        invoices(page: $page, pageSize: $pageSize, customerId: $customerId, invoiceDateStart: $invoiceDateStart, invoiceDateEnd: $invoiceDateEnd) {
            pageInfo {
                currentPage
                totalPages
            }
            edges {
                node {
                    invoiceNumber
                    invoiceDate
                    amountDue {
                        value
                    }
                    status
                    viewUrl
                    customer {
                        name
                    }
                    payments {
                        paymentDate
                        amount
                        paymentMethod
                    }
                }
            }
        }
    }
}
`;

const CUSTOMERS_QUERY = `
query($businessId: ID!, $page: Int!, $pageSize: Int!) {
    business(id: $businessId) {
        customers(page: $page, pageSize: $pageSize) {
            pageInfo {
                currentPage
                totalPages
            }
            edges {
                node {
                    id
                    name
                }
            }
        }
    }
}
`;

// 请求某一页数据（发票或客户，由传进来的 query/variables 决定）；遇到 Wave 的限速会自动等待后重试
async function graphqlRequestWithRetry(acc, label, queryString, variables, page, attempt = 1) {
    console.log(`[Wave Debug] 正在请求公司: ${acc.name} (${label}), 第 ${page} 页${attempt > 1 ? ` (第 ${attempt} 次尝试)` : ''}`);

    const response = await axios.post(WAVE_GRAPHQL_URL, {
        query: queryString,
        variables: variables
    }, {
        headers: {
            "Authorization": `Bearer ${acc.token}`,
            "Content-Type": "application/json"
        }
    });

    console.log(`[Wave Debug] ${acc.name} (${label}) 第 ${page} 页请求成功，状态码: ${response.status}`);

    const rateLimitError = response.data.errors?.find(e => e.extensions?.code === 'RATE_LIMITED');

    if (rateLimitError) {
        if (attempt >= MAX_RETRIES_PER_PAGE) {
            console.log(`[Wave Debug] ${acc.name} (${label}) 第 ${page} 页被限速 ${attempt} 次后放弃`);
            return { business: null, gaveUp: true };
        }

        const resetAtMs = rateLimitError.extensions?.resetAt ? new Date(rateLimitError.extensions.resetAt).getTime() : NaN;
        const waitMs = Number.isFinite(resetAtMs)
            ? Math.max(resetAtMs - Date.now(), 300) + 300 // 多留 300ms 缓冲
            : 1000 * attempt; // 拿不到 resetAt 就用简单的递增等待兜底

        console.log(`[Wave Debug] ${acc.name} (${label}) 第 ${page} 页被限速，等待 ${waitMs}ms 后重试`);
        await sleep(waitMs);
        return graphqlRequestWithRetry(acc, label, queryString, variables, page, attempt + 1);
    }

    if (response.data.errors) {
        console.log(`[Wave Debug] ${acc.name} (${label}) 第 ${page} 页 GraphQL 报错:`, JSON.stringify(response.data.errors));
    }

    return { business: response.data?.data?.business, gaveUp: false };
}

// 通用翻页抓取：自动翻到最后一页，第 2 页起分批并发抓取
async function fetchAllPages(acc, label, queryString, extraVars, getConnection) {
    let allEdges = [];

    let firstResult;
    try {
        firstResult = await graphqlRequestWithRetry(acc, label, queryString, { businessId: acc.businessId, page: 1, pageSize: PAGE_SIZE, ...extraVars }, 1);
    } catch (error) {
        console.error(`Wave Search Error for ${acc.name} (${label}, page 1):`, error.response?.data || error.message);
        return allEdges;
    }

    const firstBusiness = firstResult.business;
    if (!firstBusiness) {
        if (firstResult.gaveUp) {
            console.log(`[Wave Debug] ${acc.name} (${label}) 第 1 页一直被限速，这次先放弃，等一下再搜应该就好了`);
        } else {
            console.log(`[Wave Debug] ${acc.name} (${label}) 返回数据中未找到 business，可能 ID 或 Token 不匹配。`);
        }
        return allEdges;
    }

    const firstConn = getConnection(firstBusiness);
    allEdges.push(...(firstConn?.edges || []));

    const totalPages = Math.min(firstConn?.pageInfo?.totalPages || 1, MAX_PAGES_PER_ACCOUNT);

    console.log(`[Wave Debug] ${acc.name} (${label}) 第 1/${totalPages} 页，累计 ${allEdges.length} 条`);

    let page = 2;
    while (page <= totalPages) {
        const batchPages = [];
        for (let i = 0; i < FETCH_CONCURRENCY && page <= totalPages; i++, page++) {
            batchPages.push(page);
        }

        const batchResults = await Promise.all(batchPages.map(async (p) => {
            try {
                const result = await graphqlRequestWithRetry(acc, label, queryString, { businessId: acc.businessId, page: p, pageSize: PAGE_SIZE, ...extraVars }, p);
                const conn = getConnection(result.business);
                return conn?.edges || [];
            } catch (error) {
                console.error(`Wave Search Error for ${acc.name} (${label}, page ${p}):`, error.response?.data || error.message);
                return [];
            }
        }));

        for (const edges of batchResults) {
            allEdges.push(...edges);
        }

        console.log(`[Wave Debug] ${acc.name} (${label}) 已抓到第 ${Math.min(page - 1, totalPages)}/${totalPages} 页，累计 ${allEdges.length} 条`);
    }

    return allEdges;
}

// extraFilters 可以传 { customerId, invoiceDateStart, invoiceDateEnd } 让 Wave 直接筛，不传就是整表扫（跟以前一样）
async function fetchAllInvoicesForAccount(acc, extraFilters = {}) {
    return fetchAllPages(acc, 'invoices', INVOICES_QUERY, extraFilters, (business) => business?.invoices);
}

// 客户列表通常比发票少得多，缓存起来，避免每次搜索都重新拉一遍
const customerCache = new Map(); // businessId -> { timestamp, customers: [{id, name}] }

async function getCustomersForAccount(acc) {
    const cached = customerCache.get(acc.businessId);
    if (cached && (Date.now() - cached.timestamp) < CUSTOMER_CACHE_TTL_MS) {
        return cached.customers;
    }

    const edges = await fetchAllPages(acc, 'customers', CUSTOMERS_QUERY, {}, (business) => business?.customers);
    const customers = edges.map(e => e.node).filter(Boolean);
    customerCache.set(acc.businessId, { timestamp: Date.now(), customers });
    console.log(`[Wave Debug] ${acc.name} 客户列表已缓存，共 ${customers.length} 个客户`);
    return customers;
}

// 把一些常见的口语化写法转成实际存在字段里的纯数字/文字，再去匹配
function normalizeKeyword(kw) {
    // "YE2026" -> "2026"，"YE26" -> "2026"：按年份匹配发票日期/付款日期
    // 两位数年份一律当成 20XX（这是给 2000~2099 年用的，够用很久了）
    const yeMatch = kw.match(/^ye(\d{2}|\d{4})$/);
    if (yeMatch) {
        const digits = yeMatch[1];
        return digits.length === 2 ? `20${digits}` : digits;
    }

    // "RM2720" / "RM2720.00" -> "2720" / "2720.00"：按金额匹配（金额字段本身不带 RM 字样）
    const rmMatch = kw.match(/^rm(\d+(\.\d+)?)$/);
    if (rmMatch) return rmMatch[1];

    return kw;
}

// 识别关键字是不是"年份 / 年-月 / 完整日期"，是的话转成 Wave 能直接筛的日期范围
function keywordToDateRange(kw) {
    // 完整日期，比如 2026-04-14
    if (/^\d{4}-\d{2}-\d{2}$/.test(kw)) {
        return { invoiceDateStart: kw, invoiceDateEnd: kw };
    }
    // 年-月，比如 2026-04
    if (/^\d{4}-\d{2}$/.test(kw)) {
        const [y, m] = kw.split('-').map(Number);
        const lastDay = new Date(y, m, 0).getDate(); // m 是 1-indexed 月份，Date(y, m, 0) 正好是该月最后一天
        return { invoiceDateStart: `${kw}-01`, invoiceDateEnd: `${kw}-${String(lastDay).padStart(2, '0')}` };
    }
    // 整年，比如 2026（也是 "YE2026" 归一化之后的样子）
    if (/^\d{4}$/.test(kw)) {
        return { invoiceDateStart: `${kw}-01-01`, invoiceDateEnd: `${kw}-12-31` };
    }
    return null;
}

async function searchWaveInvoice(keywordInput) {
    const keywords = keywordInput.toLowerCase().trim().split(/\s+/).filter(Boolean).map(normalizeKeyword);

    // 从关键字里找一个日期范围（年 / 年-月 / 完整日期），可以让 Wave 直接按日期筛
    let dateRange = null;
    for (const kw of keywords) {
        const range = keywordToDateRange(kw);
        if (range) {
            dateRange = range;
            break;
        }
    }

    let allMatched = [];

    const promises = WAVE_ACCOUNTS.map(async (acc) => {
        // 1. 先看看关键字里有没有能对上的客户名字。命中的话直接按 customerId 筛发票，范围通常小很多
        const customers = await getCustomersForAccount(acc);
        const matchingCustomerIds = customers
            .filter(c => {
                const nameLower = String(c.name || '').toLowerCase();
                return keywords.some(kw => kw.length >= 2 && nameLower.includes(kw));
            })
            .map(c => c.id);

        let edges;
        if (matchingCustomerIds.length > 0 && matchingCustomerIds.length <= MAX_MATCHED_CUSTOMERS_FOR_FILTER) {
            const perCustomerEdges = await Promise.all(
                matchingCustomerIds.map(cid => fetchAllInvoicesForAccount(acc, { customerId: cid, ...(dateRange || {}) }))
            );
            edges = perCustomerEdges.flat();
            console.log(`[Wave Debug] ${acc.name} 按客户名字匹配到 ${matchingCustomerIds.length} 个客户，共抓到 ${edges.length} 张发票`);
        } else if (dateRange) {
            edges = await fetchAllInvoicesForAccount(acc, dateRange);
            console.log(`[Wave Debug] ${acc.name} 没匹配到客户名字，按日期范围 ${dateRange.invoiceDateStart} ~ ${dateRange.invoiceDateEnd} 筛，抓到 ${edges.length} 张发票`);
        } else {
            edges = await fetchAllInvoicesForAccount(acc);
            console.log(`[Wave Debug] ${acc.name} 没有可下推的筛选条件，整表扫描，抓到 ${edges.length} 张发票`);
        }

        // 2. 不管上面怎么缩小范围，最后都用完整关键字逐个比对一遍，保证结果准确（筛选只是加速，不改变对不对）
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

            // 付款记录（银行转账/信用卡等收款），一张发票可能有多笔
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

// Telegram 的 Markdown（legacy）解析器很脆弱：发票号/客户名/链接这些"动态内容"里
// 只要出现一个没配对的 _ 或 *（比如链接里常见的下划线），整条消息就会被 Telegram 拒收报 400。
// 改用 HTML 格式，只需要转义 & < > 三个符号，比 Markdown 稳定很多。
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Telegram 单条消息上限是 4096 字符，这里保守留一些余量，把结果切成多条消息发送
const TELEGRAM_SAFE_LENGTH = 3500;
// 匹配结果太多的时候（比如搜到某个客户名下几百张单），只展示前面这么多条，
// 避免一次性刷几十条消息，并提示对方缩小搜索范围
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

bot.start((ctx) => {
    ctx.reply("👋 Hello! Multi-Account Wave Assistant is ready.");
});

bot.on('text', async (ctx) => {
    const messageText = ctx.message.text;

    if (messageText.startsWith('#resend') || messageText.startsWith('#find')) {
        const keyword = messageText.replace('#resend', '').replace('#find', '').trim();

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
