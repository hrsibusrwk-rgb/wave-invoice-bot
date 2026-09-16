// wave.js —— Wave GraphQL API 相关的所有逻辑：账号配置、查询、缓存、以及"写入"用的 mutation。
// #find / #resend（查询发票）和 #invoice / #edit（开票/改票）共用这个文件。

const axios = require('axios');

const WAVE_GRAPHQL_URL = "https://gql.waveapps.com/graphql/public";

// ==================== 账号配置 ====================
// 新增了 code 字段：#invoice / #edit 指令里用这个代号指定要用哪个账号开票。
// ⚠️ 安全提醒：token 目前是明文写在代码里的，而且已经在跟 Claude 的对话里出现过。
// 强烈建议：
//   1. 去 Render 项目的 Environment 设置里，把这几个值存成环境变量（下面已经改成优先读环境变量）。
//   2. 去 Telegram BotFather 和 Wave 后台，把这几个 token 重新生成一遍，作废旧的。
const WAVE_ACCOUNTS = [
    {
        code: "SCC",
        name: "Solid Capital Consulting",
        businessId: process.env.WAVE_SCC_BUSINESS_ID || "QnVzaW5lc3M6MmI5OGRiYjYtYWQ4My00OWM5LWIwZTEtYTUzNGJmYTk1MjBk",
        token: process.env.WAVE_SCC_TOKEN || "sNkMtPQuJipbBEhkxtCBL2ydBAYF2l"
    },
    {
        code: "SB",
        name: "Solid Capital Consulting Sdn. Bhd.",
        businessId: process.env.WAVE_SB_BUSINESS_ID || "QnVzaW5lc3M6NTY5NmNiMTYtZmE2Yi00NjEzLWFmNDMtYmZjMjNmNDA4NmY3",
        token: process.env.WAVE_SB_TOKEN || "CuF67Ugju7HR0w4UU9x41p9IeKpYdj"
    }
];

function findAccountByCode(code) {
    if (!code) return null;
    return WAVE_ACCOUNTS.find(a => a.code.toLowerCase() === String(code).toLowerCase()) || null;
}

// 每页拉多少条记录
const PAGE_SIZE = 50;
const MAX_PAGES_PER_ACCOUNT = 1000;
const FETCH_CONCURRENCY = 2;
const MAX_RETRIES_PER_PAGE = 5;
const CUSTOMER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const PRODUCT_CACHE_TTL_MS = 10 * 60 * 1000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 查询语句 ====================

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
                    id
                    invoiceNumber
                    invoiceDate
                    amountDue {
                        value
                    }
                    status
                    viewUrl
                    customer {
                        id
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

// ⚠️ 待核实：products 这个字段名、以及底下的字段（是否叫 name / description）需要跟 Wave 的实际 schema 核对一遍。
// 可以用下面的 introspectType('ProductConnection') 或者 introspectType('Product') 来查。
const PRODUCTS_QUERY = `
query($businessId: ID!, $page: Int!, $pageSize: Int!) {
    business(id: $businessId) {
        products(page: $page, pageSize: $pageSize) {
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

// ==================== 请求 + 重试 ====================

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
            return { business: null, gaveUp: true, errors: response.data.errors };
        }

        const resetAtMs = rateLimitError.extensions?.resetAt ? new Date(rateLimitError.extensions.resetAt).getTime() : NaN;
        const waitMs = Number.isFinite(resetAtMs)
            ? Math.max(resetAtMs - Date.now(), 300) + 300
            : 1000 * attempt;

        console.log(`[Wave Debug] ${acc.name} (${label}) 第 ${page} 页被限速，等待 ${waitMs}ms 后重试`);
        await sleep(waitMs);
        return graphqlRequestWithRetry(acc, label, queryString, variables, page, attempt + 1);
    }

    if (response.data.errors) {
        console.log(`[Wave Debug] ${acc.name} (${label}) 第 ${page} 页 GraphQL 报错:`, JSON.stringify(response.data.errors));
    }

    return { business: response.data?.data?.business, gaveUp: false, errors: response.data.errors, raw: response.data };
}

// 通用翻页抓取
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

async function fetchAllInvoicesForAccount(acc, extraFilters = {}) {
    return fetchAllPages(acc, 'invoices', INVOICES_QUERY, extraFilters, (business) => business?.invoices);
}

// ==================== 客户 / 产品 缓存 ====================

const customerCache = new Map(); // businessId -> { timestamp, customers: [{id, name}] }
const productCache = new Map();  // businessId -> { timestamp, products: [{id, name}] }

async function getCustomersForAccount(acc, forceRefresh = false) {
    const cached = customerCache.get(acc.businessId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CUSTOMER_CACHE_TTL_MS) {
        return cached.customers;
    }

    const edges = await fetchAllPages(acc, 'customers', CUSTOMERS_QUERY, {}, (business) => business?.customers);
    const customers = edges.map(e => e.node).filter(Boolean);
    customerCache.set(acc.businessId, { timestamp: Date.now(), customers });
    console.log(`[Wave Debug] ${acc.name} 客户列表已缓存，共 ${customers.length} 个客户`);
    return customers;
}

async function getProductsForAccount(acc, forceRefresh = false) {
    const cached = productCache.get(acc.businessId);
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < PRODUCT_CACHE_TTL_MS) {
        return cached.products;
    }

    const edges = await fetchAllPages(acc, 'products', PRODUCTS_QUERY, {}, (business) => business?.products);
    const products = edges.map(e => e.node).filter(Boolean);
    productCache.set(acc.businessId, { timestamp: Date.now(), products });
    console.log(`[Wave Debug] ${acc.name} 产品/服务列表已缓存，共 ${products.length} 个`);
    return products;
}

function invalidateCustomerCache(acc) {
    customerCache.delete(acc.businessId);
}
function invalidateProductCache(acc) {
    productCache.delete(acc.businessId);
}

// 按发票号找发票（用于 #edit）。号码允许只输入数字部分（比如 "4475"），也允许输入完整号码（比如 "SCC4475"）。
async function findInvoiceByNumber(acc, invoiceNumberInput) {
    const target = String(invoiceNumberInput).trim().toLowerCase();
    const edges = await fetchAllInvoicesForAccount(acc);
    const invoices = edges.map(e => e.node).filter(Boolean);

    let match = invoices.find(inv => String(inv.invoiceNumber).toLowerCase() === target);
    if (!match) {
        match = invoices.find(inv => String(inv.invoiceNumber).toLowerCase().endsWith(target));
    }
    return match || null;
}

// ==================== Mutation：写入 ====================
// ⚠️ 下面这几个 mutation 的字段名，是根据 Wave 公开 GraphQL API 已知的用法写的，
// 但没能在当前环境里对着 Wave 的实时 schema 逐字核对（网络被挡住了）。
// 上线前务必：
//   1. 用最下面的 introspectType() 函数（或者 Telegram 里的 #schema 指令）实际查一遍这几个 Input 类型的字段。
//   2. 用一张测试发票跑一遍，检查 Wave 后台看到的内容跟预期一致。
// 如果调用失败，图片解析/建票流程会把 Wave 返回的 errors 原文回复到 Telegram 里，可以直接照着报错改字段名。

const CUSTOMER_CREATE_MUTATION = `
mutation($input: CustomerCreateInput!) {
    customerCreate(input: $input) {
        customer { id name }
        didSucceed
        inputErrors { message code path }
    }
}
`;

const PRODUCT_CREATE_MUTATION = `
mutation($input: ProductCreateInput!) {
    productCreate(input: $input) {
        product { id name }
        didSucceed
        inputErrors { message code path }
    }
}
`;

const INVOICE_CREATE_MUTATION = `
mutation($input: InvoiceCreateInput!) {
    invoiceCreate(input: $input) {
        invoice { id invoiceNumber viewUrl status }
        didSucceed
        inputErrors { message code path }
    }
}
`;

const INVOICE_PATCH_MUTATION = `
mutation($input: InvoicePatchInput!) {
    invoicePatch(input: $input) {
        invoice { id invoiceNumber viewUrl status }
        didSucceed
        inputErrors { message code path }
    }
}
`;

async function runMutation(acc, mutationString, variables) {
    const response = await axios.post(WAVE_GRAPHQL_URL, {
        query: mutationString,
        variables
    }, {
        headers: {
            "Authorization": `Bearer ${acc.token}`,
            "Content-Type": "application/json"
        }
    });
    return response.data; // { data, errors }
}

async function createCustomer(acc, name) {
    const result = await runMutation(acc, CUSTOMER_CREATE_MUTATION, {
        input: { businessId: acc.businessId, name }
    });
    return result;
}

async function createProduct(acc, name) {
    // ⚠️ 待核实：Wave 的 ProductCreateInput 有可能要求额外字段（比如收入科目 incomeAccountId）。
    // 如果这里报错说缺少某个字段，去 Wave 后台 Products & Services 手动建一个同名产品，
    // 再用 #schema ProductCreateInput 查一下到底哪些是必填。
    const result = await runMutation(acc, PRODUCT_CREATE_MUTATION, {
        input: { businessId: acc.businessId, name }
    });
    return result;
}

async function createInvoice(acc, { customerId, items, status = "SAVED" }) {
    const result = await runMutation(acc, INVOICE_CREATE_MUTATION, {
        input: {
            businessId: acc.businessId,
            customerId,
            status, // "SAVED" = 已确认但不自动寄出；如果 Wave 报枚举值不对，用 #schema InvoiceCreateStatus 查正确的值
            items: items.map(i => ({
                productId: i.productId,
                description: i.description,
                quantity: i.qty,
                unitPrice: i.price
            }))
        }
    });
    return result;
}

async function patchInvoiceItems(acc, invoiceId, items) {
    const result = await runMutation(acc, INVOICE_PATCH_MUTATION, {
        input: {
            id: invoiceId,
            items: items.map(i => ({
                productId: i.productId,
                description: i.description,
                quantity: i.qty,
                unitPrice: i.price
            }))
        }
    });
    return result;
}

// ==================== Schema 自查（临时调试用） ====================
// 通过 Telegram 发 "#schema InvoiceCreateInput" 之类的指令，就能查到 Wave 那个类型实际有哪些字段。
// 等正式核对完 schema、功能稳定之后，可以把这个指令从 bot.js 里拿掉。

const INTROSPECT_QUERY = `
query TypeInfo($name: String!) {
    __type(name: $name) {
        name
        kind
        inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
        fields { name type { kind name ofType { kind name ofType { kind name } } } }
        enumValues { name }
    }
}
`;

function fmtGraphQLType(t) {
    if (!t) return "?";
    if (t.kind === "NON_NULL") return fmtGraphQLType(t.ofType) + "!";
    if (t.kind === "LIST") return "[" + fmtGraphQLType(t.ofType) + "]";
    return t.name || "?";
}

async function introspectType(acc, typeName) {
    const result = await runMutation(acc, INTROSPECT_QUERY, { name: typeName });
    const data = result?.data?.__type;
    if (!data) {
        return `没查到类型 "${typeName}"，检查一下名字有没有打对。\n` + (result.errors ? JSON.stringify(result.errors) : '');
    }
    const lines = [`${data.name} (${data.kind})`];
    for (const f of (data.inputFields || [])) {
        lines.push(`  ${f.name}: ${fmtGraphQLType(f.type)}`);
    }
    for (const f of (data.fields || [])) {
        lines.push(`  ${f.name}: ${fmtGraphQLType(f.type)}`);
    }
    for (const e of (data.enumValues || [])) {
        lines.push(`  ENUM ${e.name}`);
    }
    return lines.join('\n');
}

module.exports = {
    WAVE_ACCOUNTS,
    findAccountByCode,
    sleep,
    fetchAllPages,
    fetchAllInvoicesForAccount,
    getCustomersForAccount,
    getProductsForAccount,
    invalidateCustomerCache,
    invalidateProductCache,
    findInvoiceByNumber,
    createCustomer,
    createProduct,
    createInvoice,
    patchInvoiceItems,
    introspectType
};
