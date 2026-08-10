// 매일 카테고리별 인기 쇼츠를 수집해 data/ 폴더에 JSON으로 저장합니다.
// GitHub Actions에서 자동 실행됩니다.

const fs = require('fs');
const path = require('path');

const KEY = process.env.YOUTUBE_API_KEY;
const REGION = 'KR';
const DAYS = 7;              // 최근 며칠 이내 업로드분을 볼지
const FALLBACK_DAYS = 30;    // 결과가 부족할 때 늘려볼 기간
const MIN_RESULTS = 5;       // 이보다 적으면 기간을 늘려 재시도
const MAX_SEC = 180;         // 쇼츠 최대 길이 (3분)
const PER_CATEGORY = 20;     // 카테고리당 저장 개수

// 카테고리 코드(videoCategoryId)로 거르면 결과가 비는 경우가 잦아서
// 전부 키워드 검색으로 통일했습니다. queries는 앞에서부터 순서대로 시도합니다.
const CATEGORIES = [
  { id: 'all',      name: '전체',         type: 'chart' },
  { id: 'q_music',  name: '음악/댄스',     queries: ['커버댄스 쇼츠', '노래 커버 쇼츠', '챌린지 댄스'] },
  { id: 'q_game',   name: '게임',         queries: ['게임 쇼츠', '게임 하이라이트 쇼츠', '롤 배그 쇼츠'] },
  { id: 'q_funny',  name: '코미디/밈',     queries: ['웃긴영상 쇼츠', '개그 쇼츠', '밈 쇼츠'] },
  { id: 'q_pet',    name: '반려동물',      queries: ['강아지 고양이 쇼츠', '반려동물 쇼츠'] },
  { id: 'q_beauty', name: '뷰티/패션',     queries: ['뷰티 메이크업 쇼츠', '메이크업 튜토리얼 쇼츠'] },
  { id: 'q_sport',  name: '스포츠',       queries: ['스포츠 하이라이트 쇼츠', '축구 야구 쇼츠'] },
  { id: 'q_vlog',   name: '브이로그/일상', queries: ['일상 브이로그 쇼츠', '브이로그 쇼츠'] },
  { id: 'q_food',   name: '먹방/요리',     queries: ['먹방 쇼츠', '요리 레시피 쇼츠'] },
  { id: 'q_asmr',   name: 'ASMR',        queries: ['ASMR 쇼츠', 'ASMR 소리'] }
];

const API = 'https://www.googleapis.com/youtube/v3/';

function isoDaysAgo(days){
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function durSeconds(iso){
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if(!m) return 9999;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

async function apiGet(pathName, params){
  const url = API + pathName + '?' + new URLSearchParams({ ...params, key: KEY });
  const res = await fetch(url);
  const data = await res.json();
  if(data.error){
    throw new Error(pathName + ': ' + (data.error.message || '요청 실패'));
  }
  return data;
}

async function collectIds(cat, days, query){
  if(cat.type === 'chart'){
    const d = await apiGet('videos', {
      part: 'id', chart: 'mostPopular', regionCode: REGION, maxResults: '50'
    });
    return (d.items || []).map(v => v.id);
  }

  const d = await apiGet('search', {
    part: 'id', type: 'video', videoDuration: 'short',
    order: 'viewCount', maxResults: '50',
    publishedAfter: isoDaysAgo(days), regionCode: REGION,
    relevanceLanguage: 'ko',
    q: query
  });
  return (d.items || []).map(it => it.id && it.id.videoId).filter(Boolean);
}

async function fetchDetails(ids){
  const out = [];
  for(let i = 0; i < ids.length; i += 50){
    const d = await apiGet('videos', {
      part: 'snippet,statistics,contentDetails',
      id: ids.slice(i, i + 50).join(',')
    });
    out.push(...(d.items || []));
  }
  return out;
}

// 상위 영상들의 공통 패턴 계산 -> 콘텐츠 소재로 사용
function analyze(videos){
  if(videos.length === 0) return null;

  const secs = videos.map(v => v.durationSec);
  const avgSec = Math.round(secs.reduce((a,b) => a+b, 0) / secs.length);

  const hourCount = {};
  videos.forEach(v => {
    const h = new Date(v.publishedAt).getUTCHours();
    const kst = (h + 9) % 24;           // 한국시간으로 변환
    const slot = Math.floor(kst / 3) * 3;
    hourCount[slot] = (hourCount[slot] || 0) + 1;
  });
  const bestSlot = Object.entries(hourCount).sort((a,b) => b[1] - a[1])[0];

  const titleLens = videos.map(v => v.title.length);
  const avgTitleLen = Math.round(titleLens.reduce((a,b) => a+b, 0) / titleLens.length);

  const withHashtag = videos.filter(v => v.title.includes('#')).length;

  return {
    avgDurationSec: avgSec,
    peakUploadSlotKST: bestSlot ? `${bestSlot[0]}~${Number(bestSlot[0])+3}시` : null,
    peakUploadShare: bestSlot ? Math.round(bestSlot[1] / videos.length * 100) : null,
    avgTitleLength: avgTitleLen,
    hashtagShare: Math.round(withHashtag / videos.length * 100),
    medianViews: [...videos].sort((a,b) => a.views - b.views)[Math.floor(videos.length/2)].views
  };
}

async function main(){
  if(!KEY) throw new Error('YOUTUBE_API_KEY 가 설정되지 않았습니다.');

  const result = { date: new Date().toISOString().slice(0,10), region: REGION, categories: {} };

  // 검색어를 순서대로 시도하고, 그래도 부족하면 기간을 늘려 재시도
  async function gather(cat, days, query){
    const after = new Date(isoDaysAgo(days)).getTime();
    const ids = await collectIds(cat, days, query);
    const detail = await fetchDetails([...new Set(ids)]);

    return detail
      .map(v => ({
        id: v.id,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        publishedAt: v.snippet.publishedAt,
        views: Number(v.statistics.viewCount || 0),
        likes: Number(v.statistics.likeCount || 0),
        comments: Number(v.statistics.commentCount || 0),
        durationSec: durSeconds(v.contentDetails.duration),
        thumb: (v.snippet.thumbnails.medium || v.snippet.thumbnails.default || {}).url || ''
      }))
      .filter(v => v.durationSec <= MAX_SEC)
      .filter(v => new Date(v.publishedAt).getTime() >= after)
      .sort((a,b) => b.views - a.views)
      .slice(0, PER_CATEGORY);
  }

  for(const cat of CATEGORIES){
    try{
      let best = [], usedDays = DAYS, usedQuery = null;

      if(cat.type === 'chart'){
        best = await gather(cat, DAYS, null);
      }else{
        // 1) 기본 기간으로 검색어를 하나씩 시도
        for(const q of cat.queries){
          const got = await gather(cat, DAYS, q);
          if(got.length > best.length){ best = got; usedQuery = q; }
          if(best.length >= MIN_RESULTS) break;
        }
        // 2) 그래도 부족하면 첫 검색어로 기간을 늘려 재시도
        if(best.length < MIN_RESULTS){
          const wider = await gather(cat, FALLBACK_DAYS, cat.queries[0]);
          if(wider.length > best.length){
            best = wider; usedDays = FALLBACK_DAYS; usedQuery = cat.queries[0];
          }
        }
      }

      result.categories[cat.id] = {
        name: cat.name,
        windowDays: usedDays,
        query: usedQuery,
        videos: best,
        stats: analyze(best)
      };

      console.log(`${cat.name}: ${best.length}개 (최근 ${usedDays}일${usedQuery ? ', "' + usedQuery + '"' : ''})`);
    }catch(e){
      console.error(`${cat.name} 실패: ${e.message}`);
      result.categories[cat.id] = { name: cat.name, videos: [], stats: null, error: e.message };
    }
  }

  // '전체'는 급상승 차트만으로는 쇼츠가 몇 개 안 남으므로
  // 모든 카테고리에서 모은 영상을 합쳐 통합 랭킹으로 다시 만듭니다. (추가 호출 없음)
  const merged = new Map();
  Object.entries(result.categories).forEach(([id, c]) => {
    if(id === 'all') return;
    (c.videos || []).forEach(v => merged.set(v.id, v));
  });
  (result.categories.all.videos || []).forEach(v => merged.set(v.id, v));

  const allVideos = [...merged.values()]
    .sort((a,b) => b.views - a.views)
    .slice(0, PER_CATEGORY);

  result.categories.all = {
    name: '전체',
    windowDays: DAYS,
    query: null,
    videos: allVideos,
    stats: analyze(allVideos)
  };
  console.log(`전체(통합): ${allVideos.length}개`);

  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${result.date}.json`), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(result, null, 1));

  // 날짜 목록도 갱신 (과거 데이터 조회용)
  const files = fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json',''))
    .sort()
    .reverse();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(files, null, 1));

  console.log(`저장 완료: data/${result.date}.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
