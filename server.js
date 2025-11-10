// .env 파일에서 환경 변수(API 키)를 로드
require('dotenv').config();

const express = require('express');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

// ✅ Node 18+: 전역 fetch, 그 미만은 node-fetch 동적 import
const fetch =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Gemini 초기화
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
const port = 3001; // 유저님이 사용하시던 3001 포트

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // public 폴더 서빙
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ========================== 캐시 & 타임아웃 ========================== */

const HTML_CACHE = new Map();
const EXTRACT_CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function getCache(map, key) {
  const v = map.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) {
    map.delete(key);
    return null;
  }
  return v.value;
}
function setCache(map, key, value, ttl = CACHE_TTL_MS) {
  map.set(key, { value, expires: Date.now() + ttl });
  if (map.size > 500) map.delete(map.keys().next().value);
}
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/* ========================= 유틸 & 언어 처리 ========================= */

// 🔥 [버그 수정] 구매링크 식별 로직 강화 (검색/카테고리 제외)
function isYouTubeUrl(s) {
  if (!s) return false;
  const t = s.toLowerCase();
  return t.includes('youtube.com/') || t.includes('youtu.be/');
}
function isLikelyCommerceUrl(s) {
  if (!s) return false;
  const t = s.toLowerCase();
  
  // 1. 도메인 체크
  const domainRegex = /(coupang|smartstore|smartstore\.naver|11st|gmarket|auction|ssg|musinsa|wemakeprice|tmon|danawa|amazon|iherb|oliveyoung|rakuten)/;
  if (!domainRegex.test(t)) return false;
  
  // 2. "제품" 경로 우대
  const productPathRegex = /(products|product|goods|p|pr|vp|item|deal|store\/goods)/;
  if (productPathRegex.test(t)) return true;
  
  // 3. "검색/카테고리" 경로 제외
  const searchPathRegex = /(search|category|list|best)/;
  if (searchPathRegex.test(t)) return false;
  
  // 4. "제품 ID" 파라미터 우대
  const productParamRegex = /(itemid|vendoritemid|gd_no|item_no|i=)/;
  if (productParamRegex.test(t)) return true;

  // 5. 도메인은 맞지만 위 3,4에 해당 안되면 '제품 링크'가 아닌 '일반 링크'로 취급
  return false; 
}
function pickMeta(html, name) {
  const r = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(r);
  return m ? m[1] : '';
}
function pickTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}
function extractH1Candidates(html) {
  const hs = [];
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = m[1].replace(/<[^>]*>/g, '').trim();
    if (text) hs.push(text);
  }
  return hs;
}
function decodeJSONString(s) { try { return JSON.parse(`"${s}"`); } catch { return s; } }

function getLangFromReq(req) {
  const bodyLang = (req.body && req.body.lang) || '';
  const headLang = (req.headers['x-yakson-lang'] || '').toString().toLowerCase();
  if (bodyLang === 'en' || headLang.startsWith('en')) return 'en';
  if (bodyLang === 'ko' || headLang.startsWith('ko')) return 'ko';
  const al = (req.headers['accept-language'] || '').toString().toLowerCase();
  return al.includes('en') ? 'en' : 'ko';
}
function acceptLanguageHeader(lang) {
  return lang === 'en'
    ? 'en-US,en;q=0.9,ko;q=0.6'
    : 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5';
}

/* ============================ YouTube ============================== */

async function extractYouTubeContext(url, lang) {
  const cacheKey = `yt:${lang}:${url}`;
  const c = getCache(EXTRACT_CACHE, cacheKey);
  if (c) return c;

  const out = { url, title: '', author: '', description: '' };

  try {
    const o = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      {}, 1500
    );
    if (o?.ok) {
      const data = await o.json();
      out.title = data.title || '';
      out.author = data.author_name || '';
    }
  } catch {}

  try {
    const r = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': acceptLanguageHeader(lang) } },
      2000
    );
    if (r?.ok) {
      const html = await r.text();
      const m = html.match(/"shortDescription":"([^"]+)"/);
      if (m) out.description = decodeJSONString(m[1]);
      if (!out.title) {
        const mt = html.match(/<meta property="og:title" content="([^"]+)"/i);
        if (mt) out.title = mt[1];
      }
      if (!out.author) {
        const ma = html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/);
        if (ma) out.author = ma[1];
      }
    }
  } catch {}

  const source = [
    `TITLE: ${out.title}`,
    `CHANNEL: ${out.author}`,
    `DESCRIPTION: ${out.description}`,
  ].join('\n').slice(0, 8000);

  const ctx = { ...out, source };
  setCache(EXTRACT_CACHE, cacheKey, ctx);
  return ctx;
}

function classifyYouTubeAdContext(title = '', description = '') {
  const t = (String(title) + ' ' + String(description)).toLowerCase();
  const productHints = /(product|제품|신제품|캡슐|정\b|파우더|보충제|supplement|vitamin|probiotic|mg\b|효능|효과|임상|review|리뷰|사용기|개봉기|언박싱|가격|구매|링크)/;
  const brandHints   = /(브랜드|기업|회사|신뢰|히스토리|스토리|브랜드관|캠페인|brand film|brand ad|brand campaign|회사소개|브랜드 소개|our story|philosophy|official)/;
  if (productHints.test(t)) return 'product_ad';
  if (brandHints.test(t)) return 'brand_ad';
  return 'unknown';
}

/* =========================== Commerce ============================= */

// 🔥 [버그 수정] 쿠팡 검색 링크가 같은 캐시를 공유하는 문제 수정
function normalizeCommerceUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    
    // Coupang: Only normalize product pages
    if (host.includes('coupang.com')) {
      const p = u.pathname;
      // Check if it's a product page path
      if (p.startsWith('/vp/products/') || p.startsWith('/products/')) {
        u.hostname = 'm.coupang.com';
        const keep = new URLSearchParams();
        for (const [k, v] of u.searchParams.entries()) {
          if (k === 'itemId' || k === 'vendorItemId') keep.set(k, v);
        }
        u.search = keep.toString();
        return u.toString();
      }
      // If it's NOT a product page (e.g., search), return raw to avoid cache collision
      return raw; 
    }
    
    // Naver Smartstore: Strip tracking params
    if (host.includes('smartstore.naver.com')) {
        const keep = new URLSearchParams();
        // Keep the product ID param 'i' or 'products'
        if (u.searchParams.has('i')) {
           keep.set('i', u.searchParams.get('i'));
        }
        // Keep the pathname if it's a product path
        if (u.pathname.startsWith('/products/')) {
           // Keep the path
        } else {
           u.pathname = '/'; // Clear category/search paths
        }
        u.search = keep.toString();
        return u.toString();
    }
    
    return raw; // Default: return raw
  } catch { return raw; }
}

function extractJsonLdProducts(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const json = JSON.parse(m[1]);
      if (Array.isArray(json)) json.forEach((j) => blocks.push(j));
      else blocks.push(json);
    } catch {}
  }
  const products = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b['@type'] === 'Product') products.push(b);
    if (Array.isArray(b['@graph'])) {
      for (const g of b['@graph']) if (g?.['@type'] === 'Product') products.push(g);
    }
  }
  return products;
}

/* ===== [NEW] 제품명 정제/추론 헬퍼 (추가) ===== */

// 사이트 접미사/전치사 제거 (쿠팡/스마트스토어/아마존 등 공통 패턴)
/* ===== [NEW] 제품명 정제/추론 헬퍼 (추가) ===== */
function cleanSiteSuffixes(str, host='') {
  if (!str) return '';
  let s = String(str).replace(/\s+/g,' ').trim();

  const splitters = [' | ', ' - ', ' · '];
  for (const sp of splitters) {
    const parts = s.split(sp);
    if (parts.length > 1) {
      const last = parts[parts.length - 1].trim();
      if (last && last.length >= 4) s = last;
    }
  }

  const low = (host||'').toLowerCase();
  if (low.includes('coupang')) s = s.replace(/쿠팡!?/gi,'').replace(/COUPANG!?/gi,'').trim();
  if (low.includes('smartstore.naver')) s = s.replace(/스마트스토어|네이버\s*쇼핑|NAVER\s*Shopping/gi,'').trim();
  if (low.includes('amazon')) s = s.replace(/Amazon(\.com)?/gi,'').trim();
  if (low.includes('iherb')) s = s.replace(/iHerb/gi,'').trim();
  if (low.includes('oliveyoung')) s = s.replace(/올리브영|Olive\s*Young/gi,'').trim();

  s = s.replace(/\((?:SKU|Item)?\s*#?\s*\d{5,}\)/gi, '').trim();
  s = s.replace(/^[-|·]+\s*/,'').replace(/\s*[-|·]+$/,'').trim();
  return s;
}

function pickCleanProductName({ host='', ogTitle='', h1s=[], titleTag='', html='' }) {
  const candidates = [];
  if (html) {
    const jsonNameKeys = [
      /"productName"\s*:\s*"([^"]{3,200})"/i,
      /"itemName"\s*:\s*"([^"]{3,200})"/i,
      /"goodsName"\s*:\s*"([^"]{3,200})"/i,
      /"name"\s*:\s*"([^"]{3,200})"\s*,\s*"@type"\s*:\s*"Product"/i,
    ];
    for (const re of jsonNameKeys) {
      const m = html.match(re);
      if (m && m[1]) candidates.push(m[1]);
    }
  }
  if (ogTitle) candidates.push(ogTitle);
  if (Array.isArray(h1s) && h1s.length) candidates.push(h1s[0]);
  if (titleTag) candidates.push(titleTag);

  for (let c of candidates) {
    const cleaned = cleanSiteSuffixes(c, host);
    if (cleaned && cleaned.length >= 2) return cleaned;
  }
  return '';
}


/* ===== (여기까지 NEW) ===== */

// 🔥 [강화] 다양한 User-Agent 풀 (쿠팡 차단 회피)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 🔥 [강화] 재시도 로직 추가
async function fetchWithRetry(url, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url, opts, 5000); // 타임아웃 2초 → 5초
      if (res?.ok) return res;
      console.log(`[Retry ${i + 1}/${retries + 1}] Failed to fetch ${url}: ${res?.status}`);
    } catch (err) {
      console.log(`[Retry ${i + 1}/${retries + 1}] Error fetching ${url}:`, err.message);
      if (i === retries) throw err;
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1))); // 지수 백오프
    }
  }
  return null;
}

async function getHtmlFast(url, lang) {
  const norm = normalizeCommerceUrl(url);
  const cached = getCache(HTML_CACHE, `${lang}:${norm}`);
  if (cached) return cached;
  
  try {
    const headers = {
      'User-Agent': getRandomUserAgent(), // 🔥 랜덤 User-Agent
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': acceptLanguageHeader(lang),
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };
    
    // 🔥 쿠팡은 Referer 헤더를 중요하게 봄
    const urlObj = new URL(norm);
    if (urlObj.hostname.includes('coupang.com')) {
      headers['Referer'] = 'https://www.coupang.com/';
      headers['Origin'] = 'https://www.coupang.com';
      // 🔥 쿠팡 쿠키 추가 (세션 유지)
      headers['Cookie'] = 'PCID=dummy; overrideAbTestGroup=dummy;';
    }
    
    const res = await fetchWithRetry(norm, { headers }, 2); // 🔥 2번 재시도로 증가
    if (res?.ok) {
      const html = await res.text();
      
      // 🔥 [강화] HTML이 너무 짧으면 (CSR 페이지) null 반환
      if (html.length < 500) {
        console.log(`[getHtmlFast] HTML too short (${html.length} chars), likely CSR page: ${url}`);
        return null;
      }
      
      setCache(HTML_CACHE, `${lang}:${norm}`, html);
      return html;
    }
  } catch (err) {
    console.error(`[getHtmlFast] Failed to fetch ${url}:`, err.message);
  }
  return null;
}
async function extractCommerceContext(url, lang) {
  const cacheKey = `cm:${lang}:${url}`;
  const cached = getCache(EXTRACT_CACHE, cacheKey);
  if (cached) return cached;

  const html = await getHtmlFast(url, lang);
  if (!html) {
    let productId = '';
    try { productId = new URL(url).pathname.match(/\/products\/(\d+)/)?.[1] || ''; } catch {}
    const quickSource = [`URL: ${url}`, productId && `PRODUCT_ID_HINT: ${productId}`, 'NOTE: FAST_MODE_FALLBACK'].filter(Boolean).join('\n');
    const quickCtx = { productName:'', brand:'', manufacturer:'', seller:'', sku:'', category:'', description:'', source:quickSource };
    setCache(EXTRACT_CACHE, cacheKey, quickCtx, 30 * 60 * 1000);
    return quickCtx;
  }

  const ogTitle = pickMeta(html, 'og:title');
  const ogDesc = pickMeta(html, 'og:description');
  const ogSite = pickMeta(html, 'og:site_name');
  const titleTag = pickTitle(html);
  const h1s = extractH1Candidates(html);
  const products = extractJsonLdProducts(html);
  const host = (()=>{ try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })(); // <-- [ADD]

  let productName='', brand='', manufacturer='', sku='', category='', seller='', description='';

  if (products.length) {
    const p = products[0];
    productName = p.name || '';
    if (typeof p.brand === 'string') brand = p.brand;
    else if (p.brand?.name) brand = p.brand.name;
    manufacturer = (p.manufacturer?.name) || p.manufacturer || '';
    sku = p.sku || '';
    category = p.category || '';
    if (p.offers?.seller) seller = (p.offers.seller.name || '').trim();
    description = p.description || '';
  }

  if (!productName) productName = ogTitle || h1s[0] || titleTag;

  // [ADD] JSON-LD/OG/H1/Title로도 깔끔히 못 잡았을 때 사이트별/내장 JSON까지 긁어 강제 정제
  if (!productName || productName.length < 2) {
    productName = pickCleanProductName({ host, ogTitle, h1s, titleTag, html });
  } else {
    // 이미 값이 있어도 사이트 접미사/잡스러운 토큰 제거
    productName = cleanSiteSuffixes(productName, host);
  }

  if (!description) description = ogDesc;
  if (!seller) seller = ogSite;

  const lines = [`URL: ${url}`];
  if (productName) lines.push(`PRODUCT_NAME: ${productName}`);
  if (brand) lines.push(`BRAND: ${brand}`);
  if (manufacturer) lines.push(`MANUFACTURER: ${manufacturer}`);
  if (seller) lines.push(`SELLER: ${seller}`);
  if (sku) lines.push(`SKU: ${sku}`);
  if (category) lines.push(`CATEGORY: ${category}`);
  if (description) lines.push(`DESCRIPTION: ${description}`);

  const source = lines.join('\n').slice(0, 8000);
  const ctx = { productName, brand, manufacturer, seller, sku, category, description, source };
  setCache(EXTRACT_CACHE, cacheKey, ctx);
  return ctx;
}

/* ======================= 브랜드 티어/표준화 (개선) ======================= */

// 대기업 브랜드 목록
const BRAND_ALIASES = {
  // A-Tier: 대기업
  '정관장': ['정관장','KGC 정관장','KGC','케이지씨'],
  'KGC인삼공사': ['KGC인삼공사','Korea Ginseng Corp','KGC Corporation'],
  'CJ제일제당': ['CJ제일제당','CJ CheilJedang','씨제이제일제당','CJ'],
  '유한양행': ['유한양행','Yuhan','유한'],
  '종근당': ['종근당','CKD','Chong Kun Dang','종근당건강'],
  'GC녹십자': ['GC녹십자','녹십자','Green Cross','지씨녹십자'],
  '대웅제약': ['대웅제약','Daewoong','대웅','대웅바이오'],
  '동아제약': ['동아제약','Donga','동아에스티'],
  '일동제약': ['일동제약','Ildong','일동'],
  '한미약품': ['한미약품','Hanmi','한미'],
  '광동제약': ['광동제약','Kwangdong','광동'],
  '일양약품': ['일양약품','Ilyang','일양'],
  '삼성제약': ['삼성제약','Samsung Pharm'],
  'LG생활건강': ['LG생활건강','LG H&H','엘지생활건강','LG'],
  'Amorepacific': ['Amorepacific','아모레퍼시픽','아모레'],
  'Pfizer': ['Pfizer','Pfizer Inc.','화이자','화이자제약'],
  'Bayer': ['Bayer','바이엘','바이엘코리아'],
  'GSK': ['GSK','GlaxoSmithKline','글락소스미스클라인'],
  'Johnson & Johnson': ['Johnson & Johnson','존슨앤드존슨','존슨앤존슨','존슨'],
  'Reckitt': ['Reckitt','레킷벤키저','레킷'],
  'Abbott': ['Abbott','애보트','애벗'],
  'Sanofi': ['Sanofi','사노피'],
  'Novartis': ['Novartis','노바티스'],
  'Merck': ['Merck','머크'],
  '보령제약': ['보령제약', '보령'],
  '한독': ['한독'],
  '동국제약': ['동국제약'],
  'JW중외제약': ['JW중외제약', '중외제약'],
  '대원제약': ['대원제약'],
  '오뚜기': ['오뚜기', 'Ottogi'],
  '농심': ['농심', 'Nongshim'],
  '대상': ['대상', 'Daesang'],
  '풀무원': ['풀무원', 'Pulmuone'],
  '롯데': ['롯데', 'Lotte'],
  '매일유업': ['매일유업', 'Maeil'],
  '남양유업': ['남양유업', 'Namyang'],
  'MSD': ['MSD'],
  'Roche': ['Roche', '로슈'],
  'Nestlé': ['Nestlé', '네슬레'],
  'P&G': ['P&G', 'Procter & Gamble'],
  '암웨이': ['암웨이', 'Amway'],
  '허벌라이프': ['허벌라이프', 'Herbalife'],
};

// B-Tier: 알려진 유명 브랜드 (90점 이상 목표)
const B_TIER_KNOWN_BRANDS = {
  '뉴트리원': ['뉴트리원', 'Nutri One'],
  '닥터스베스트': ['닥터스베스트', "Doctor's Best", 'Doctors Best'],
  '솔가': ['솔가', 'Solgar'],
  '나우푸드': ['나우푸드', 'NOW Foods', 'Now'],
  '자로우': ['자로우', 'Jarrow', 'Jarrow Formulas'],
  '네이처스웨이': ['네이처스웨이', "Nature's Way", 'Natures Way'],
  '네이처메이드': ['네이처메이드', 'Nature Made'],
  '센트룸': ['센트룸', 'Centrum'],
  '얼라이브': ['얼라이브', 'Alive'],
  '칼슘디': ['칼슘디', 'CalciumD'],
  '종근당건강': ['종근당건강', '종근당'],
  '뉴트리디데이': ['뉴트리디데이', 'Nutri D-Day'],
  '뉴트리코어': ['뉴트리코어', 'Nutricore'],
  '닥터린': ['닥터린', 'Dr.Lin'],
  '비타민월드': ['비타민월드', 'Vitamin World'],
  '마이프로틴': ['마이프로틴', 'Myprotein'],
  '옵티멈뉴트리션': ['옵티멈뉴트리션', 'Optimum Nutrition', 'ON'],
  '머슬팜': ['머슬팜', 'MusclePharm'],
  '뉴트리바이오틱스': ['뉴트리바이오틱스', 'Nutribiotic'],
  'California Gold Nutrition': ['California Gold Nutrition', 'CGN', '캘리포니아골드'],
  '스포츠리서치': ['스포츠리서치', 'Sports Research'],
  '라이프익스텐션': ['라이프익스텐션', 'Life Extension'],
  '유한건강생활': ['유한건강생활', '유한'],
  '경남제약': ['경남제약'],
  '한미양행': ['한미양행'],
};

// 🔥 [신규] OTC-Tier: 잘 알려진 일반의약품 (95점 이상 보장)
const OTC_MEDICINES = {
  '타이레놀': ['타이레놀', 'Tylenol', '타이레놀이알'],
  '게보린': ['게보린', 'Gevorin'],
  '펜잘': ['펜잘', 'Fenzal', 'Fenzal Q'],
  '판피린': ['판피린', 'Panpyrin'],
  '아스피린': ['아스피린', 'Aspirin', '바이엘 아스피린'],
  '어린이타이레놀': ['어린이타이레놀', '어린이 타이레놀'],
  '부루펜': ['부루펜', 'Brufen'],
  '이지엔6': ['이지엔6', 'EaseN6', '이지엔'],
  '판콜': ['판콜', 'Pancol'],
  '콜대원': ['콜대원'],
  '코푸시럽': ['코푸시럽', '코푸'],
  '베아제': ['베아제', 'Beazyme'],
  '훼스탈': ['훼스탈', 'Festal'],
  '닥터베아제': ['닥터베아제', '닥터 베아제'],
  '탈모논': ['탈모논'],
  '게보린쿨': ['게보린쿨', '게보린 쿨'],
  '애니펜': ['애니펜'],
  '어린이부루펜': ['어린이부루펜', '어린이 부루펜'],
  '훼라민큐': ['훼라민큐', '훼라민Q'],
  '삐콤씨': ['삐콤씨'],
  '비맥스': ['비맥스', 'Bemax'],
  '센시아': ['센시아', 'Sensia'],
  '벤포벨': ['벤포벨'],
  '케라시스': ['케라시스', 'Kerasys'],
  '마데카솔': ['마데카솔', 'Madecassol'],
  '후시딘': ['후시딘', 'Fucidin'],
  '박트로반': ['박트로반', 'Bactroban'],
  '듀오덤': ['듀오덤', 'Duoderm'],
  '메디폼': ['메디폼', 'Medifoam'],
  '이지엔6애니': ['이지엔6애니'],
  '그날엔': ['그날엔'],
  '탁센': ['탁센'],
};

// 🔥 [신규] 위험 물질 블랙리스트 (0점 처리)
const BLACKLIST_KEYWORDS = [
  // 마약류
  '메스암페타민', '필로폰', '히로뽕', '대마초', '코카인', '헤로인', '엑스터시', 'LSD', 'MDMA',
  '펜타닐', 'GHB', '케타민', '크랙', '아편', '모르핀', '옥시코돈', '펜터민',
  // 향정신성 의약품 (불법 유통)
  '졸피뎀', '자낙스', 'Xanax', '알프라졸람', '로라제팜', '클로나제팜', '리보트릴',
  // 불법 다이어트약
  '살빼는약', '마약다이어트', '비만약불법', '펜터민불법',
  // 가짜 의약품
  '가짜비아그라', '짝퉁', '위조의약품', '밀수',
  // 명확한 사기
  '100%완치', '암완치', 'HIV완치', '당뇨완치', '기적의약',
  // 검색 안 되는 제품 키워드
  '제품을 찾을 수 없', '검색 결과 없', 'No results found', '존재하지 않는 제품',
];

const A_TIER = new Set(Object.keys(BRAND_ALIASES));
const B_TIER_KNOWN = new Set(Object.keys(B_TIER_KNOWN_BRANDS));
const OTC_TIER = new Set(Object.keys(OTC_MEDICINES)); // 🔥 OTC 티어 추가

// 브랜드 정규화 함수 - 다양한 표기를 표준 브랜드명으로 통일
function canonicalizeBrandFromText(sourceText) {
  const t = (sourceText || '').toLowerCase();
  // A-Tier 브랜드 체크
  for (const [canon, aliases] of Object.entries(BRAND_ALIASES)) {
    for (const a of aliases) {
      if (t.includes(a.toLowerCase())) return canon;
    }
  }
  // B-Tier 유명 브랜드 체크
  for (const [canon, aliases] of Object.entries(B_TIER_KNOWN_BRANDS)) {
    for (const a of aliases) {
      if (t.includes(a.toLowerCase())) return canon;
    }
  }
  // 🔥 OTC 일반의약품 체크
  for (const [canon, aliases] of Object.entries(OTC_MEDICINES)) {
    for (const a of aliases) {
      if (t.includes(a.toLowerCase())) return canon;
    }
  }
  return null;
}

// 🔥 [신규] 블랙리스트 체크 함수
function isBlacklisted(sourceText) {
  const t = (sourceText || '').toLowerCase();
  for (const keyword of BLACKLIST_KEYWORDS) {
    if (t.includes(keyword.toLowerCase())) {
      return { isBlacklisted: true, keyword };
    }
  }
  return { isBlacklisted: false, keyword: null };
}

// 브랜드 티어 판정
function getBrandTier(brand) {
  if (!brand) return 'C'; // 브랜드 없음
  if (A_TIER.has(brand)) return 'A'; // 대기업
  if (OTC_TIER.has(brand)) return 'OTC'; // 🔥 일반의약품
  if (B_TIER_KNOWN.has(brand)) return 'B'; // 알려진 유명 브랜드
  return 'C'; // 일반 브랜드
}

/* ===================== 광고 유형별 평가 기준 (🔥 수정) ===================== */

// 🔥 차별화된 8단계 항목명 (클라이언트로 전송됨)
const STEP_NAMES = {
  product_itself: [
    "제품 식별", "제조사 신뢰도 (30점)", "제품 신뢰도 (40점)", "공식 정보 검증 (10점)",
    "핵심 성분 분석 (15점)", "행동 유도 (N/A)", "시각적 신호 (N/A)", "금전 피해 (5점)"
  ],
  brand_ad: [
    "광고 식별", "채널 신뢰도 (25점)", "브랜드 신뢰도 (15점)", "표현/내용 검증 (25점)",
    "효능/성분 위반 (10점)", "행동 유도 검증 (15점)", "시각적 신호 (5점)", "사기·금전 피해 (5점)"
  ],
  product_ad: [
    "광고 식별", "발신자 신뢰도 (20점)", "제품 신뢰도 (30점)", "표현/내용 검증 (20점)",
    "효능/성분 위반 (20점)", "행동 유도 검증 (5점)", "시각적 신호 (3점)", "사기·금전 피해 (2점)"
  ],
  unknown: [
    "콘텐츠 식별", "발신자 신뢰도 (20점)", "제품 신뢰도 (25점)", "표현/내용 검증 (20점)",
    "효능/성분 위반 (20점)", "행동 유도 검증 (8점)", "시각적 신호 (4점)", "사기·금전 피해 (3점)"
  ]
};

// 광고 유형 정의
const AD_TYPE_CRITERIA = {
  // 제품 자체 평가 기준
  product_itself: {
    name: '제품 정보',
    description: '광고가 아닌 제품 자체의 공식 정보 분석',
    // 🔥 점수 보정 기준: A-Tier(대기업) 98점, OTC(일반의약품) 95점, B-Tier Known(유명 브랜드) 95점 목표
    minScoreFloor: {
      A_tier: { step2: 29, step3: 39, step4: 10, step5: 15, step6: 0, step7: 0, step8: 5 }, // 98
      OTC_tier: { step2: 28, step3: 38, step4: 10, step5: 14, step6: 0, step7: 0, step8: 5 }, // 95 🔥 일반의약품
      B_tier_known: { step2: 28, step3: 37, step4: 10, step5: 14, step6: 0, step7: 0, step8: 5 }, // 94 -> 95+ 목표
      B_tier: { step2: 20, step3: 30, step4: 7, step5: 12, step6: 0, step7: 0, step8: 4 }, // 73
    }
  },
  // 브랜드 광고: 기업 이미지, 신뢰도 중심
  brand_ad: {
    name: '브랜드 광고',
    description: '기업 이미지, 철학, 역사 중심의 광고',
    minScoreFloor: {
      A_tier: { step2: 24, step3: 15, step4: 24, step5: 10, step6: 15, step7: 5, step8: 5 }, // 98
      OTC_tier: { step2: 23, step3: 14, step4: 23, step5: 10, step6: 15, step7: 5, step8: 5 }, // 95 🔥 일반의약품
      B_tier_known: { step2: 23, step3: 14, step4: 23, step5: 10, step6: 15, step7: 5, step8: 5 }, // 95
      B_tier: { step2: 15, step3: 10, step4: 16, step5: 8, step6: 10, step7: 3, step8: 4 }, // 66
    }
  },
  
  // 제품 광고: 제품 효능, 성분, 안전성 중심
  product_ad: {
    name: '제품 광고',
    description: '특정 제품의 효능, 성분, 사용법 중심의 광고',
    minScoreFloor: {
      A_tier: { step2: 20, step3: 30, step4: 20, step5: 20, step6: 5, step7: 3, step8: 2 }, // 100 (상한선)
      OTC_tier: { step2: 19, step3: 29, step4: 19, step5: 19, step6: 5, step7: 3, step8: 2 }, // 96 -> 95+ 🔥 일반의약품
      B_tier_known: { step2: 19, step3: 29, step4: 19, step5: 19, step6: 5, step7: 3, step8: 2 }, // 96 -> 95+ 목표
      B_tier: { step2: 12, step3: 20, step4: 15, step5: 14, step6: 3, step7: 2, step8: 1 }, // 67
    }
  },
  
  // 일반/미분류
  unknown: {
    name: '일반 콘텐츠',
    description: '광고 유형이 불명확한 경우',
    minScoreFloor: {
      A_tier: { step2: 20, step3: 25, step4: 20, step5: 20, step6: 8, step7: 4, step8: 3 }, // 100 (상한선)
      OTC_tier: { step2: 19, step3: 24, step4: 19, step5: 19, step6: 8, step7: 4, step8: 3 }, // 96 -> 95+ 🔥 일반의약품
      B_tier_known: { step2: 19, step3: 24, step4: 19, step5: 19, step6: 8, step7: 4, step8: 3 }, // 96 -> 95+ 목표
      B_tier: { step2: 10, step3: 16, step4: 14, step5: 13, step6: 5, step7: 2, step8: 1 }, // 61
    }
  }
};

/* ===================== 스키마/프롬프트 (🔥 뱃지 + 항목명 추가) ===================== */

// 모든 뱃지 필드 + stepNames 스키마에 추가
const analysisResponseSchema = {
  type: 'OBJECT',
  properties: {
    productInfo: { type: 'STRING' },
    productType: { type: 'STRING' },
    totalScore: { type: 'INTEGER' },
    overallSafety: { type: 'STRING', enum: ['안전','주의','위험'] },
    safetyReason: { type: 'STRING' },
    precautions: { type: 'STRING' },
    // 뱃지 필드
    isMfdsRegistered: { type: 'BOOLEAN' },
    isGmpCertified: { type: 'BOOLEAN' },
    isOrganic: { type: 'BOOLEAN' },
    // 🔥 뱃지 키 추가 (비타민 세분화)
    mainIngredients: { type: 'ARRAY', items: { type: 'STRING', enum: ['omega3', 'vitamin_b', 'vitamin_c', 'vitamin_d', 'vitamin_e', 'collagen', 'ginseng', 'protein', 'lutein', 'magnesium', 'zinc', 'calcium', 'probiotics', 'milkthisle', 'coq10'] } },
    targetAudience: { type: 'ARRAY', items: { type: 'STRING', enum: ['kids', 'women', 'men', 'senior', 'pregnant'] } },
    adType: { type: 'STRING', enum: ['brand_ad', 'product_ad', 'product_itself', 'unknown'] },
    // 차별화된 항목명
    stepNames: { type: 'ARRAY', items: { type: 'STRING' } },
    
    analysisDetails: {
      type: 'OBJECT',
      properties: {
        step1_identification: { type:'OBJECT', properties:{ result:{type:'STRING'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['result','reason'] },
        step2_senderScore:    { type:'OBJECT', properties:{ score:{type:'INTEGER'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['score','reason'] },
        step3_productScore:   { type:'OBJECT', properties:{ score:{type:'INTEGER'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['score','reason'] },
        step4_expressionScore:{ type:'OBJECT', properties:{ score:{type:'INTEGER'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['score','reason'] },
        step5_efficacyScore:  { type:'OBJECT', properties:{ score:{type:'INTEGER'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['score','reason'] },
        step6_actionScore:    { type:'OBJECT', properties:{ score:{type:'INTEGER'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['score','reason'] },
        step7_visualScore:    { type:'OBJECT', properties:{ score:{type:'INTEGER'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['score','reason'] },
        step8_financialScore: { type:'OBJECT', properties:{ score:{type:'INTEGER'}, reason:{type:'STRING'}, evidence:{type:'ARRAY', items:{type:'STRING'}} }, required:['score','reason'] },
      },
      required: ['step1_identification','step2_senderScore','step3_productScore','step4_expressionScore','step5_efficacyScore','step6_actionScore','step7_visualScore','step8_financialScore'],
    },
  },
  required: ['productInfo','productType','totalScore','overallSafety','safetyReason','analysisDetails','precautions', 'isMfdsRegistered', 'isGmpCertified', 'isOrganic', 'mainIngredients', 'targetAudience', 'adType', 'stepNames'],
};

// 🔥 프롬프트 수정 (뱃지 영어 키 명시, stepNames 추가)
const PROMPT = {
  ko: {
    base: (input) => `
당신은 한국의 건강기능식품/의약품 광고 신뢰도 평가 AI(약손)입니다.
입력: "${input}"
규칙:
- JSON만 출력합니다.
- 각 step.evidence에는 SOURCE_TEXT의 **직접 문자열**을 넣으세요(없으면 0점 가능).
- 레드플래그(완치/치료/100%/기적/불법/사기/다단계/피싱 등)는 강한 감점.
- 점수 상한: S2 15, S3 25, S4 20, S5 20, S6 10, S7 5, S8 5. (유형별로 다름)
- 총점 등급: 80~100 안전 / 50~79 주의 / 0~49 위험.
- 🔥 [뱃지 규칙] 뱃지 필드(isMfdsRegistered, isGmpCertified, isOrganic, mainIngredients, targetAudience)를 반드시 채우세요.
- 🔥 [뱃지 규칙] mainIngredients: 반드시 다음 **영어 키** 리스트에서만 선택. (예: "활성형 비타민 B1" -> ["vitamin_b"]) ['omega3', 'vitamin_b', 'vitamin_c', 'vitamin_d', 'vitamin_e', 'collagen', 'ginseng', 'protein', 'lutein', 'magnesium', 'zinc', 'calcium', 'probiotics', 'milkthisle', 'coq10']
- 🔥 [뱃지 규칙] targetAudience: 반드시 다음 **영어 키** 리스트에서만 선택. (예: "어린이" -> ["kids"]) ['kids', 'women', 'men', 'senior', 'pregnant']
- 🔥 [항목명 규칙] "stepNames": 8개 항목의 표시 이름을 배열로 제공해야 합니다. (아래 제공된 stepNames 사용)
`,
    // 🔥 8단계 항목명(stepNames)을 프롬프트에 직접 지정
    ytSys: `유튜브 입력입니다. 아래 SOURCE_TEXT만 사용하세요. 외부 지식/추측 금지.`,
    cmSys:  `커머스 입력입니다. 아래 SOURCE_TEXT만 사용하세요. 외부 지식/추측 금지.`,
    // 🔥 adType과 stepNames를 외부에서 주입 (AI가 추측 못하게)
    ytBrandAd:  `분석유형: 브랜드 광고.`,
    ytProductAd:`분석유형: 제품 광고.`,
    // 🔥 "제품명 평가" 프롬프트 수정
    productNameSearchSys: `
[작업] 제품명만 입력되었습니다. Google Search 도구를 사용하여 이 제품의 공식 정보를 찾으세요.
[분석] 검색된 공식 정보(제조사, 식약처 인증, 성분, GMP, 유기농 여부)를 바탕으로 8단계 분석을 모두 수행하세요.
[규칙] 광고가 아닌 제품 *자체*의 신뢰도를 분석합니다.
[규칙] S6(행동유도), S7(시각신호) 점수는 0점으로 하고 "제품명 검색으로 분석 항목 아님"으로 사유를 기재하세요.
[필수] 모든 뱃지 필드(isMfdsRegistered, isGmpCertified, isOrganic, mainIngredients, targetAudience)를 검색 결과에 따라 채우세요.
`,
  },
  en: { base: ()=>'Output JSON only; use SOURCE_TEXT only.', ytSys:'YouTube', cmSys:'Commerce', ytBrandAd:'Brand ad', ytProductAd:'Product ad', productNameSearchSys: 'Product name only. Use Google Search to find info and analyze all 8 steps. Fill all badge fields. Set S6, S7 score to 0.' },
};

/* ===================== 점수 후처리 (🔥 버그 수정) ===================== */

// 🔥 [버그 수정] 점수 상한선을 adType별로 정확하게 정의
const SCORE_CAPS = {
  product_itself: { s2: 30, s3: 40, s4: 10, s5: 15, s6: 0, s7: 0, s8: 5 },
  brand_ad:       { s2: 25, s3: 15, s4: 25, s5: 10, s6: 15, s7: 5, s8: 5 },
  product_ad:     { s2: 20, s3: 30, s4: 20, s5: 20, s6: 5, s7: 3, s8: 2 },
  unknown:        { s2: 20, s3: 25, s4: 20, s5: 20, s6: 8, s7: 4, s8: 3 }
};
// (기존 SCORE_CAP 변수는 삭제)

function clamp(n, lo, hi){ n = Number(n||0); if(Number.isNaN(n)) n=0; return Math.max(lo, Math.min(hi, n)); }
function arr(x){ return Array.isArray(x) ? x : (x ? [String(x)] : []); }

// 🔥 [버그 수정] ensureStep에서 max 상한선 제거 (AI가 준 점수 그대로 받음)
function ensureStep(obj, fallbackEvidence=[]) {
  const score = clamp(obj?.score, 0, 100); // 상한선 100으로 넉넉하게
  const reason = (obj?.reason || '').toString();
  let evidence = arr(obj?.evidence);
  if (evidence.length === 0 && fallbackEvidence.length) evidence = fallbackEvidence.slice(0, 3);
  return { score, reason, evidence };
}

// 신뢰도 플래그 감지 (브랜드 티어 포함)
function detectTrustFlags(sourceText='') {
  const src = (sourceText || '').toLowerCase();
  const brand = canonicalizeBrandFromText(sourceText);
  const tier = getBrandTier(brand);
  const isOfficialWord = /(official|공식)/.test(src);
  const channelLine = (src.match(/channel:\s*([^\n]+)/i) || [,''])[1].toLowerCase();
  const titleLine   = (src.match(/title:\s*([^\n]+)/i) || [,''])[1].toLowerCase();
  const brandInChannel = brand && channelLine.includes(brand.toLowerCase());
  const brandInTitle   = brand && titleLine.includes(brand.toLowerCase());
  const trustedSeller = /(seller|url|site_name|판매처).*(coupang|smartstore|naver|amazon|oliveyoung)/i.test(sourceText);
  
  return { 
    brand, 
    tier,
    isOfficialChannel: (isOfficialWord || brandInChannel || brandInTitle), 
    isTrustedSeller: trustedSeller,
    isMajorCorp: tier === 'A',
    isOTC: tier === 'OTC', // 🔥 일반의약품 플래그 추가
    isKnownBrand: tier === 'B' // 🔥 유명 브랜드 플래그 추가
  };
}

// 보수적 게이트 (레드 플래그 감지)
function conservativeGates(steps) {
  const text = Object.values(steps).map(s => (s.reason||'') + ' ' + (s.evidence||[]).join(' ')).join(' ').toLowerCase();
  const red = /(완치|치료|기적|100%|부작용 없음|불법|사기|다단계|피싱)/.test(text);
  if (red) {
    steps.step4_expressionScore.score = Math.min(steps.step4_expressionScore.score, 2);
    steps.step5_efficacyScore.score = Math.min(steps.step5_efficacyScore.score, 2);
  }
  return red;
}

// 🔥 [버그 수정] "대기업 점수 보정" 로직 (100점 버그 원인 제거)
function applyAdTypeTrustFloors(steps, flags, adType, sourceText) {
  const fb = (sourceText || '').split('\n').filter(l => /^(channel|url|product_name|seller|brand|title|description)/i.test(l)).slice(0,3);
  
  const criteria = AD_TYPE_CRITERIA[adType] || AD_TYPE_CRITERIA.unknown;
  
  // 🔥 티어 우선순위: A-Tier(대기업) > OTC(일반의약품) > B-Tier Known(유명 브랜드) > B-Tier(일반)
  let tierKey = 'B_tier'; // 기본값
  if (flags.isMajorCorp) {
    tierKey = 'A_tier'; // 대기업
  } else if (flags.isOTC) {
    tierKey = 'OTC_tier'; // 일반의약품
  } else if (flags.isKnownBrand) {
    tierKey = 'B_tier_known'; // 유명 브랜드
  }
  
  // 🔥 대기업, 일반의약품, 유명 브랜드, 공식 채널, 신뢰 판매처일 경우 점수 보정
  if (flags.isMajorCorp || flags.isOTC || flags.isKnownBrand || flags.isOfficialChannel || flags.isTrustedSeller) {
    const floors = criteria.minScoreFloor[tierKey];
    
    if (floors) {
      // 🔥 각 단계별 최소 보장 점수 적용
      steps.step2_senderScore.score = Math.max(steps.step2_senderScore.score, floors.step2);
      steps.step3_productScore.score = Math.max(steps.step3_productScore.score, floors.step3);
      steps.step4_expressionScore.score = Math.max(steps.step4_expressionScore.score, floors.step4);
      steps.step5_efficacyScore.score = Math.max(steps.step5_efficacyScore.score, floors.step5);
      
      if (adType === 'product_itself') {
        steps.step6_actionScore.score = 0; // N/A 항목은 0점 고정
        steps.step7_visualScore.score = 0; // N/A 항목은 0점 고정
      } else {
        steps.step6_actionScore.score = Math.max(steps.step6_actionScore.score, floors.step6);
        steps.step7_visualScore.score = Math.max(steps.step7_visualScore.score, floors.step7);
      }
      steps.step8_financialScore.score = Math.max(steps.step8_financialScore.score, floors.step8);

      // 근거가 비어있으면 채우기 (점수는 보정됐는데 근거가 없으면 이상하므로)
      for (const k of ['step2_senderScore','step3_productScore']) {
        if (!steps[k].evidence.length && fb.length) steps[k].evidence = fb;
        if (!steps[k].reason || steps[k].reason.includes("0점")) {
          let tierLabel = '일반';
          if (flags.isMajorCorp) tierLabel = '대기업';
          else if (flags.isOTC) tierLabel = '일반의약품 (OTC)';
          else if (flags.isKnownBrand) tierLabel = '유명 브랜드';
          else if (flags.isOfficialChannel) tierLabel = '공식 채널';
          
          steps[k].reason = `${tierLabel}(${flags.brand || '확인됨'})으로 최소 신뢰 점수가 적용되었습니다.`;
        }
      }
    }
  }
}

// 🔥 100점 버그 수정: normalizeOutput에서 점수 계산 로직 단순화
function normalizeOutput(raw, lang='ko', sourceText='', adType='unknown') {
  // adType은 AI의 추측(raw.adType)이 아닌, *내가* 판단한 adType을 우선 사용
  const finalAdType = adType || raw?.adType || 'unknown';
  
  // 🔥 [블랙리스트 체크] 위험 물질/마약류/검색 불가 제품은 0점 처리
  const blacklistCheck = isBlacklisted(sourceText + ' ' + (raw?.productInfo || ''));
  if (blacklistCheck.isBlacklisted) {
    return {
      productInfo: raw?.productInfo || '위험 제품',
      productType: '위험 물질 감지',
      totalScore: 0,
      overallSafety: lang==='en'?'Risk':'위험',
      safetyReason: `이 제품은 위험 물질 또는 불법 제품으로 판단되었습니다. (키워드: ${blacklistCheck.keyword})`,
      precautions: '절대 구매하거나 복용하지 마세요. 불법 의약품일 가능성이 있습니다.',
      analysisDetails: {
        step1_identification: { result: '위험 제품', reason: '블랙리스트 키워드 감지', evidence: [blacklistCheck.keyword] },
        step2_senderScore: { score: 0, reason: '위험 물질로 판정', evidence: [] },
        step3_productScore: { score: 0, reason: '위험 물질로 판정', evidence: [] },
        step4_expressionScore: { score: 0, reason: '위험 물질로 판정', evidence: [] },
        step5_efficacyScore: { score: 0, reason: '위험 물질로 판정', evidence: [] },
        step6_actionScore: { score: 0, reason: '위험 물질로 판정', evidence: [] },
        step7_visualScore: { score: 0, reason: '위험 물질로 판정', evidence: [] },
        step8_financialScore: { score: 0, reason: '위험 물질로 판정', evidence: [] },
      },
      isMfdsRegistered: false,
      isGmpCertified: false,
      isOrganic: false,
      mainIngredients: [],
      targetAudience: [],
      adType: finalAdType,
      stepNames: STEP_NAMES[finalAdType] || STEP_NAMES.unknown,
    };
  }
  
  const base = {
    productInfo: raw?.productInfo || '',
    productType: raw?.productType || (lang==='en'?'Unidentified':'식별 불가'),
    safetyReason: raw?.safetyReason || '',
    precautions: raw?.precautions || (lang==='en'?'Use with caution.':'복용에 주의하십시오.'),
    analysisDetails: raw?.analysisDetails || {},
    // 뱃지 필드 기본값 설정
    isMfdsRegistered: raw?.isMfdsRegistered || false,
    isGmpCertified: raw?.isGmpCertified || false,
    isOrganic: raw?.isOrganic || false,
    mainIngredients: Array.isArray(raw?.mainIngredients) ? raw.mainIngredients : [],
    targetAudience: Array.isArray(raw?.targetAudience) ? raw.targetAudience : [],
    adType: finalAdType,
    // 차별화된 항목명 적용
    stepNames: raw?.stepNames && raw.stepNames.length === 8 ? raw.stepNames : (STEP_NAMES[finalAdType] || STEP_NAMES.unknown),
  };

  const fallbackEv = (sourceText || '').split('\n').filter(l => /^(channel|url|product_name|seller|brand|title|description)/i.test(l)).slice(0,3);
  const d = base.analysisDetails;

  // 🔥 [버그 수정] 점수 상한선을 가져오기 전에, AI 원본 점수만 먼저 정리
  const capRaw = (k, fb) => ensureStep(d[k], fb); // (상한선 제거)
  d.step1_identification  = { result: (d.step1_identification?.result || base.productInfo || '').toString(), reason: (d.step1_identification?.reason || '').toString(), evidence: arr(d.step1_identification?.evidence) };
  d.step2_senderScore     = capRaw('step2_senderScore',     fallbackEv);
  d.step3_productScore    = capRaw('step3_productScore',    fallbackEv);
  d.step4_expressionScore = capRaw('step4_expressionScore');
  d.step5_efficacyScore   = capRaw('step5_efficacyScore');
  d.step6_actionScore     = capRaw('step6_actionScore');
  d.step7_visualScore     = capRaw('step7_visualScore');
  d.step8_financialScore  = capRaw('step8_financialScore');

  // 레드 플래그 체크
  conservativeGates(d);

  // 신뢰도 플래그 감지
  const flags = detectTrustFlags(sourceText || raw.productInfo);
  
  // 🔥 "대기업 점수 보정" 로직 (개별 점수를 직접 수정)
  applyAdTypeTrustFloors(d, flags, base.adType, sourceText);

  // 🔥 [버그 수정] 점수 보정(Floor)이 끝난 *이후에* 유형별 상한선(Cap) 적용
  const caps = SCORE_CAPS[base.adType] || SCORE_CAPS.unknown;
  d.step2_senderScore.score     = clamp(d.step2_senderScore.score,     0, caps.s2);
  d.step3_productScore.score    = clamp(d.step3_productScore.score,    0, caps.s3);
  d.step4_expressionScore.score = clamp(d.step4_expressionScore.score, 0, caps.s4);
  d.step5_efficacyScore.score   = clamp(d.step5_efficacyScore.score,   0, caps.s5);
  d.step6_actionScore.score     = clamp(d.step6_actionScore.score,     0, caps.s6);
  d.step7_visualScore.score     = clamp(d.step7_visualScore.score,     0, caps.s7);
  d.step8_financialScore.score  = clamp(d.step8_financialScore.score,  0, caps.s8);

  // 🔥 [버그 수정] 이제 총점은 보너스나 억지 최저점 없이, 순수하게 8단계의 *합*입니다.
  let total =
    d.step2_senderScore.score + d.step3_productScore.score + d.step4_expressionScore.score +
    d.step5_efficacyScore.score + d.step6_actionScore.score + d.step7_visualScore.score +
    d.step8_financialScore.score;

  base.totalScore = clamp(total, 0, 100); // 100점 상한선만 적용
  base.overallSafety =
    base.totalScore >= 80 ? (lang==='en'?'Safe':'안전')
    : base.totalScore >= 50 ? (lang==='en'?'Caution':'주의')
    : (lang==='en'?'Risk':'위험');
  
  // 제품명이 비어있으면 S1 결과로 채우기
  if (!base.productInfo) base.productInfo = d.step1_identification.result;


  return { ...base, analysisDetails: d, isMajorCorp: flags.isMajorCorp, isKnownBrand: flags.isKnownBrand, isOTC: flags.isOTC }; // 🔥 isOTC 플래그 추가
}

/* ========================= 분석 엔드포인트 (🔥 수정) ========================= */

app.post('/api/analyze', async (req, res) => {
  const { productInfo } = req.body;
  const lang = getLangFromReq(req);
  if (!productInfo) {
    return res.status(400).json({ error: lang==='en' ? 'Please enter product name or link.' : '제품명 또는 구매 링크를 입력해주세요.' });
  }

  // 🔥 [유형 구분 수정] AI 호출 전에 서버에서 먼저 유형을 판단합니다.
  const isYoutubeVideo = isYouTubeUrl(productInfo);
  const isCommerce = !isYoutubeVideo && isLikelyCommerceUrl(productInfo);
  // 🔥 제품명 구분 강화: http, www, .com, .co.kr, .net 등이 없고, 20단어 미만일 때
  const isLikelyLink = productInfo.includes('http') || productInfo.includes('www.') || productInfo.includes('.com') || productInfo.includes('.co.kr') || productInfo.includes('.net');
  const isProductNameOnly = !isYoutubeVideo && !isCommerce && !isLikelyLink && productInfo.split(' ').length < 20;
  
  let modelConfig = {
    model: 'gemini-2.5-flash',
    config: { responseMimeType: 'application/json', responseSchema: analysisResponseSchema },
    tools: undefined,
  };

  try {
    let systemInstructionText = '';
    let userText = '';
    let sourceForPostCheck = '';
    let adType = 'unknown'; // 기본값
    let stepNames = STEP_NAMES.unknown; // 기본 항목명

    if (isYoutubeVideo) {
      const yt = await extractYouTubeContext(productInfo, lang);
      sourceForPostCheck = yt.source;
      // 🔥 AI가 아닌 내장 로직으로 광고 유형 추측
      adType = classifyYouTubeAdContext(yt.title, yt.description); 
      stepNames = STEP_NAMES[adType] || STEP_NAMES.unknown; // 유형에 맞는 항목명 선택
      
      systemInstructionText =
        PROMPT[lang].base(productInfo) + '\n' +
        // 🔥 [버그 수정] 삼항 연산자 괄호 오류 수정
        (adType==='brand_ad' ? PROMPT[lang].ytBrandAd : (adType==='product_ad' ? PROMPT[lang].ytProductAd : '')) + '\n' +
        PROMPT[lang].ytSys;
      userText = `
[SOURCE_TEXT]
${sourceForPostCheck}
[/SOURCE_TEXT]
요구사항:
- [adType: "${adType}", stepNames: ${JSON.stringify(stepNames)}]
- "productInfo" 필드에 영상 제목/채널 포함.
- 위 adType과 stepNames를 JSON에 포함시키고, 광고 유형별 평가 기준과 뱃지/항목명 규칙을 적용하여 분석하세요.
`;
    } else if (isCommerce) {
      const cm = await extractCommerceContext(productInfo, lang);
      sourceForPostCheck = [cm.source, '\nNOTE: structured/OG/title/h1 within ~2s'].join('\n');
      adType = 'product_ad'; // 쇼핑몰 링크는 '제품 광고'로 고정
      stepNames = STEP_NAMES.product_ad;
      
      // 🔥 [핵심 수정] 쿠팡/CSR 페이지는 우리가 읽지 못하므로, 무조건 Google Search를 켜서 AI가 직접 찾게 함
      modelConfig.tools = [{ google_search: {} }]; 

      systemInstructionText = PROMPT[lang].base(productInfo) + '\n' + PROMPT[lang].cmSys + '\n' + PROMPT[lang].ytProductAd;
      
      // 🔥 [최종 강화] 쿠팡 링크는 제품명 추출이 어려우므로, AI가 *반드시* URL 전체를 검색하도록 강제
      const isCoupang = productInfo.toLowerCase().includes('coupang.com');
      const searchHint = isCoupang 
        ? `\n🔥🔥🔥 [쿠팡 링크 경고] 이 URL은 JavaScript로 렌더링되므로, SOURCE_TEXT_HINT에 제품명이 비어있거나 "쇼핑 페이지"만 있을 가능성이 높습니다. *절대로* SOURCE_TEXT_HINT만 믿지 말고, 아래 URL을 Google Search로 *반드시* 검색하여 정확한 제품명을 찾으세요. 검색하지 않으면 분석이 실패합니다.\n`
        : `\n⚠️ SOURCE_TEXT_HINT에 제품명이 없거나 불명확하면, Google Search를 사용하세요.\n`;
      
      userText = `
[CRITICAL INSTRUCTION - 최우선 작업]
${searchHint}
🔥 1단계: 아래 SOURCE_TEXT_HINT를 확인하여 "PRODUCT_NAME" 필드가 비어있거나 불명확한지 체크하세요.

🔥 2단계: 만약 제품명이 비어있거나 "쇼핑 페이지", "Shopping Page", 또는 URL만 있다면, 
   다음 URL을 Google Search 도구로 *반드시* 검색하세요:
   URL: ${productInfo}
   
   검색 쿼리 예시: "${productInfo}" 또는 "쿠팡 ${productInfo.split('/').pop()}"

🔥 3단계: 검색 결과에서 이 URL에 해당하는 **정확한 제품명**을 찾으세요.

🔥 4단계: 찾은 제품명을 다음 필드에 입력하세요:
   - "productInfo" 필드
   - "step1_identification.result" 필드

[SOURCE_TEXT_HINT - 참고용]
${sourceForPostCheck}
[/SOURCE_TEXT_HINT]

추가 요구사항:
- [adType: "${adType}", stepNames: ${JSON.stringify(stepNames)}]
- 위 adType과 stepNames를 JSON에 포함시키고, 제품 광고 기준으로 평가하고 모든 뱃지/항목명 규칙을 적용하세요.
- 검색 결과가 없거나 불확실하면 "제품 확인 필요: ${productInfo}" 형태로라도 채우세요.
`;
    } else if (isProductNameOnly) {
      systemInstructionText = PROMPT[lang].base(productInfo) + '\n' + PROMPT[lang].productNameSearchSys;
      adType = 'product_itself'; // '제품명'은 '제품 자체'로 고정
      stepNames = STEP_NAMES.product_itself;
      userText = lang==='en'
        ? `Product Name: "${productInfo}". Search for this product and perform the full 8-step analysis.`
        : `제품명: "${productInfo}". 이 제품을 Google Search로 검색하고 8단계 분석을 완료하세요.`;
      
      userText += `\n[adType: "${adType}", stepNames: ${JSON.stringify(stepNames)}]`
      modelConfig.tools = [{ google_search: {} }]; // Google Search 도구 활성화

    } else { // 기타 링크
      systemInstructionText = PROMPT[lang].base(productInfo);
      userText = lang==='en' ? `User input: ${productInfo}` : `사용자 입력: ${productInfo}`;
      userText += `\n[adType: "unknown", stepNames: ${JSON.stringify(stepNames)}]`
      modelConfig.tools = [{ google_search: {} }];
    }

    const response = await ai.models.generateContent({
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: { parts: [{ text: systemInstructionText }] },
      ...modelConfig,
    });

    let raw;
    try { raw = JSON.parse(response.text); }
    catch(e) {
      console.error("JSON 파싱 오류:", e, "응답 텍스트:", response.text);
      raw = {
        productInfo: productInfo, productType: lang==='en'?'Error':'오류',
        totalScore:0, overallSafety: lang==='en'?'Risk':'위험',
        safetyReason: lang==='en'?'Model returned non-JSON.':'모델이 JSON을 반환하지 않음.',
        precautions: lang==='en'?'Use with caution.':'복용에 주의하십시오.',
        analysisDetails:{},
      };
    }

    // 🔥 adType을 내가 판단한 값(adType)으로 덮어써서 정규화
    let normalized = normalizeOutput(raw, lang, sourceForPostCheck, adType);

    // 후처리로 제품명 보강
    if (isYoutubeVideo) {
      const yt2 = await extractYouTubeContext(productInfo, lang);
      if (!normalized.productInfo) normalized.productInfo = `${yt2.title || (lang==='en'?'YouTube Video':'YouTube 영상')} (by ${yt2.author || 'unknown'})`;
    } else if (isCommerce) {
      const cm2 = await extractCommerceContext(productInfo, lang).catch(()=>null);
      if (cm2) {
        const name = cm2.productName || (lang==='en'?'Shopping Page':'쇼핑 페이지');
        // 🔥 AI가 productInfo를 비워도 cm2에서 가져오도록 보강
        if (!normalized.productInfo || normalized.productInfo.includes('쇼핑 페이지') || normalized.productInfo.includes('Shopping Page')) {
          normalized.productInfo = name;
        }
      }
    } else if (isProductNameOnly) {
      if (!normalized.productInfo) normalized.productInfo = productInfo;
    }

    // 정규화된 브랜드명으로 제품명 앞부분 보강
    const canonBrand = canonicalizeBrandFromText(sourceForPostCheck || normalized.productInfo);
    if (canonBrand && !normalized.productInfo.toLowerCase().includes(canonBrand.toLowerCase())) {
        normalized.productInfo = `${canonBrand} | ${normalized.productInfo}`;
    }

    return res.json(normalized);

  } catch (error) {
    console.error('Gemini API 호출 오류:', error);
    const lang = getLangFromReq(req);
    // 404 에러 (모델명 오류)일 경우 좀 더 친절한 메시지
    if (error.message && error.message.includes('NOT_FOUND')) {
      return res.status(500).json(
        normalizeOutput({
          productInfo: req.body?.productInfo || '',
          productType: '오류',
          safetyReason: `서버 오류: API 모델을 찾을 수 없습니다. (모델명: ${modelConfig.model})`,
          analysisDetails: {},
        }, lang, '', 'unknown')
      );
    }
    return res.status(500).json(
      normalizeOutput({
        productInfo: req.body?.productInfo || '',
        productType: lang==='en' ? 'Error' : '오류 발생',
        safetyReason: lang==='en' ? `Internal server error. (${error.message})` : `서버 내부 오류(${error.message})`,
        analysisDetails: {},
      }, lang, '', 'unknown')
    );
  }
});

/* ============================ 서버 시작 ============================ */

app.listen(port, () => {
  console.log(`🚀 약손 서버가 http://localhost:${port} 에서 실행 중입니다.`);
  console.log(`[분석 준비 완료]`);
  console.log(`[대기업 브랜드 ${A_TIER.size}개 등록됨]`);
  console.log(`[일반의약품(OTC) ${OTC_TIER.size}개 등록됨 (95점 이상 보장)]`); // 🔥 추가
  console.log(`[유명 브랜드 ${B_TIER_KNOWN.size}개 등록됨 (95점 이상 목표)]`);
  console.log(`[위험 물질 블랙리스트 ${BLACKLIST_KEYWORDS.length}개 등록됨 (0점 처리)]`); // 🔥 추가
  console.log(`[광고 유형별 평가 기준: product_itself, brand_ad, product_ad, unknown]`);
  console.log(`[API KEY: ${process.env.GEMINI_API_KEY ? '로드됨' : '없음 (환경 변수 확인 필요)'}]`);
});