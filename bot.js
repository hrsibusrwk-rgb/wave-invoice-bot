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

// 每页拉多少张发票
const PAGE_SIZE = 50;
// 单个公司最多翻多少页，防止发票超多时无限翻页
// 1000 页 * 50 张/页 = 最多抓 50000 张发票
const MAX_PAGES_PER_ACCOUNT = 1000;
// 拿到第 1 页、确认总页数之后，剩下的页数几个一批并发抓取，加快速度
const FETCH_CONCURRENCY = 5;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const INVOICES_QUERY = `
query($businessId: ID!, $page: Int!, $pageSize: Int!) {
    business(id: $businessId) {
        id
        name
        invoices(page: $page, pageSize: $pageSize) {
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

// 请求某个公司账号的某一页发票
async function fetchInvoicePage(acc, page) {
    console.log(`[Wave Debug] 正在请求公司: ${acc.name}, Business ID: ${acc.businessId}, 第 ${page} 页`);

    const response = await axios.post(WAVE_GRAPHQL_URL, {
        query: INVOICES_QUERY,
        variables: { businessId: acc.businessId, page: page, pageSize: PAGE_SIZE }
    }, {
        headers: {
            "Authorization": `Bearer ${acc.token}`,
            "Content-Type": "application/json"
        }
    });

    console.log(`[Wave Debug] ${acc.name} 第 ${page} 页请求成功，状态码: ${response.status}`);

    if (response.data.errors) {
        console.log(`[Wave Debug] ${acc.name} 第 ${page} 页 GraphQL 报错:`, JSON.stringify(response.data.errors));
    }

    return response.data?.data?.business;
}

// 拉取某个公司账号下的全部发票（自动翻页，翻到第 2 页起分批并发抓取加快速度）
async function fetchAllInvoicesForAccount(acc) {
    let allInvoices = [];

    // 先拿第 1 页，确认总页数
    let firstBusiness;
    try {
        firstBusiness = await fetchInvoicePage(acc, 1);
    } catch (error) {
        console.error(`Wave Search Error for ${acc.name} (page 1):`, error.response?.data || error.message);
        return allInvoices;
    }

    if (!firstBusiness) {
        console.log(`[Wave Debug] ${acc.name} 返回数据中未找到 business，可能 ID 或 Token 不匹配。`);
        return allInvoices;
    }

    allInvoices.push(...(firstBusiness.invoices?.edges || []));

    const totalPages = Math.min(
        firstBusiness.invoices?.pageInfo?.totalPages || 1,
        MAX_PAGES_PER_ACCOUNT
    );

    console.log(`[Wave Debug] ${acc.name} 第 1/${totalPages} 页，累计 ${allInvoices.length} 张`);

    // 剩下的页数（2..totalPages）分批并发抓取
    let page = 2;
    while (page <= totalPages) {
        const batchPages = [];
        for (let i = 0; i < FETCH_CONCURRENCY && page <= totalPages; i++, page++) {
            batchPages.push(page);
        }

        const batchResults = await Promise.all(batchPages.map(async (p) => {
            try {
                const business = await fetchInvoicePage(acc, p);
                return business?.invoices?.edges || [];
            } catch (error) {
                console.error(`Wave Search Error for ${acc.name} (page ${p}):`, error.response?.data || error.message);
                return [];
            }
        }));

        for (const edges of batchResults) {
            allInvoices.push(...edges);
        }

        console.log(`[Wave Debug] ${acc.name} 已抓到第 ${Math.min(page - 1, totalPages)}/${totalPages} 页，累计 ${allInvoices.length} 张`);
    }

    return allInvoices;
}

// 把一些常见的口语化写法转成实际存在字段里的纯数字/文字，再去匹配
function normalizeKeyword(kw) {
    // "YE2026" -> "2026"：按年份匹配发票日期/付款日期
    const yeMatch = kw.match(/^ye(\d{4})$/);
    if (yeMatch) return yeMatch[1];

    // "RM2720" / "RM2720.00" -> "2720" / "2720.00"：按金额匹配（金额字段本身不带 RM 字样）
    const rmMatch = kw.match(/^rm(\d+(\.\d+)?)$/);
    if (rmMatch) return rmMatch[1];

    return kw;
}

async function searchWaveInvoice(keywordInput) {
    const keywords = keywordInput.toLowerCase().trim().split(/\s+/).filter(Boolean).map(normalizeKeyword);
    let allMatched = [];

    const promises = WAVE_ACCOUNTS.map(async (acc) => {
        const edges = await fetchAllInvoicesForAccount(acc);
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

// Telegram 单条消息上限是 4096 字符，这里保守留一些余量，把结果切成多条消息发送
const TELEGRAM_SAFE_LENGTH = 3500;
// 匹配结果太多的时候（比如搜到某个客户名下几百张单），只展示前面这么多条，
// 避免一次性刷几十条消息，并提示对方缩小搜索范围
const MAX_RESULTS_TO_SHOW = 150;

async function replyWithResults(ctx, keyword, results) {
    const totalCount = results.length;
    const shown = results.slice(0, MAX_RESULTS_TO_SHOW);

    let chunks = [];
    let current = `🎉 **Found ${totalCount} invoice(s) matching "${keyword}":**\n`;

    for (const inv of shown) {
        const block = `\n-------------------\n` +
                      `🏢 **Account:** ${inv.accountName}\n` +
                      `📄 **Invoice No:** #${inv.invoiceNumber}\n` +
                      `🏷️ **Status:** ${inv.status}\n` +
                      `📅 **Invoice Date:** ${inv.invoiceDate}\n` +
                      `👤 **Customer:** ${inv.customerName}\n` +
                      `💰 **Amount Due:** RM${inv.amount}\n` +
                      `💵 **Payment(s):** ${inv.paymentSummary}\n` +
                      `🔗 **View Link:** ${inv.viewUrl}\n`;

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
        await ctx.reply(chunk, { parse_mode: 'Markdown', disable_web_page_preview: true });
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
            await ctx.reply("⚠️ Please provide a keyword. Example: `#resend abc 2026-06`", { parse_mode: 'Markdown' });
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
