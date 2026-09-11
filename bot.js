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

// 单个公司最多翻多少页（每页 50 条），防止发票超多时无限翻页
const MAX_PAGES_PER_ACCOUNT = 20; // 20 * 50 = 最多抓 1000 张发票

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// 拉取某个公司账号下的全部发票（自动翻页）
async function fetchAllInvoicesForAccount(acc) {
    const query = `
    query($businessId: ID!, $page: Int!) {
        business(id: $businessId) {
            id
            name
            invoices(page: $page, pageSize: 50) {
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
                    }
                }
            }
        }
    }
    `;

    let allInvoices = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= MAX_PAGES_PER_ACCOUNT) {
        console.log(`[Wave Debug] 正在请求公司: ${acc.name}, Business ID: ${acc.businessId}, 第 ${page} 页`);

        let response;
        try {
            response = await axios.post(WAVE_GRAPHQL_URL, {
                query: query,
                variables: { businessId: acc.businessId, page: page }
            }, {
                headers: {
                    "Authorization": `Bearer ${acc.token}`,
                    "Content-Type": "application/json"
                }
            });
        } catch (error) {
            console.error(`Wave Search Error for ${acc.name} (page ${page}):`, error.response?.data || error.message);
            break;
        }

        console.log(`[Wave Debug] ${acc.name} 第 ${page} 页请求成功，状态码: ${response.status}`);

        if (response.data.errors) {
            console.log(`[Wave Debug] ${acc.name} GraphQL 报错:`, JSON.stringify(response.data.errors));
        }

        const business = response.data?.data?.business;
        if (!business) {
            console.log(`[Wave Debug] ${acc.name} 返回数据中未找到 business，可能 ID 或 Token 不匹配。`);
            break;
        }

        const invoicesConn = business.invoices;
        const edges = invoicesConn?.edges || [];
        allInvoices.push(...edges);

        totalPages = invoicesConn?.pageInfo?.totalPages || 1;

        console.log(`[Wave Debug] ${acc.name} 第 ${page}/${totalPages} 页，本页 ${edges.length} 张，累计 ${allInvoices.length} 张`);

        // 如果这一页没有数据了，提前结束，避免死循环
        if (edges.length === 0) break;

        page++;
    }

    return allInvoices;
}

async function searchWaveInvoice(keywordInput) {
    const keywords = keywordInput.toLowerCase().trim().split(/\s+/).filter(Boolean);
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

            const combinedFields = `${invNum} ${custName} ${amount} ${status} ${invoiceDate}`;
            const isMatchAll = keywords.every(kw => combinedFields.includes(kw));

            if (isMatchAll) {
                matched.push({
                    accountName: acc.name,
                    invoiceNumber: inv.invoiceNumber,
                    invoiceDate: inv.invoiceDate,
                    paidDate: 'N/A',
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
            let replyText = `🎉 **Found the following invoice(s):**\n`;
            results.forEach((inv) => {
                replyText += `\n-------------------\n` +
                             `🏢 **Account:** ${inv.accountName}\n` +
                             `📄 **Invoice No:** #${inv.invoiceNumber}\n` +
                             `🏷️ **Status:** ${inv.status}\n` +
                             `📅 **Invoice Date:** ${inv.invoiceDate}\n` +
                             `👤 **Customer:** ${inv.customerName}\n` +
                             `💰 **Amount:** RM${inv.amount}\n` +
                             `🔗 **View Link:** ${inv.viewUrl}\n`;
            });
            await ctx.reply(replyText, { parse_mode: 'Markdown', disable_web_page_preview: true });
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
