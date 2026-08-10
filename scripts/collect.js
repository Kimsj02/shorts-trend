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

// 카테고리 코드는 업로더가 직접 고르는 값이라 실제 내용과 자주 어긋납니다.
// 물량이 적거나 분류가 부정확한 주제는 키워드 검색으로 잡습니다.
const CATEGORIES = [
  { id: 'all',     name: '전체',         type: 'chart' },
  { id: 'c10',     name: '음악/댄스',     type: 'category', value: '10' },
  { id: 'c20',     name: '게임',         type: 'category', value: '20' },
  { id: 'c23',     name: '코미디/밈',     type: 'category', value: '23' },
  { id: 'q_pet',   name: '반려동물',      type: 'query',    value: '강아지 고양이 쇼츠' },
  { id: 'q_beauty',name: '뷰티/패션',     type: 'query',    value: '뷰티 메이크업 쇼츠' },
  { id: 'q_sport', name: '스포츠',       type: 'query',    value: '스포츠 하이라이트 쇼츠' },
  { id: 'q_vlog',  name: '브이로그/일상', type: 'query',    value: '일상 브이로그 쇼츠' },
  { id: 'q_food',  name: '먹방/요리',     type: 'query',    value: '먹방 쇼츠' },
  { id: 'q_asmr',  name: 'ASMR',        type: 'query',    value: 'ASMR 쇼츠' }
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

async function collectIds(cat, days){
  if(cat.type === 'chart'){
    const d = await apiGet('videos', {
      part: 'id', chart: 'mostPopular', regionCode: REGION, maxResults: '50'
    });
    return (d.items || []).map(v => v.id);
  }

  const params = {
    part: 'id', type: 'video', videoDuration: 'short',
    order: 'viewCount', maxResults: '50',
    publishedAfter: isoDaysAgo(days), regionCode: REGION
  };
  if(cat.type === 'category') params.videoCategoryId = cat.value;
  if(cat.type === 'query')    params.q = cat.value;

  const d = await apiGet('search', params);
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

  // 지정 기간으로 한 번 시도하고, 결과가 적으면 기간을 늘려 다시 시도
  async function gather(cat, days){
    const after = new Date(isoDaysAgo(days)).getTime();
    const ids = await collectIds(cat, days);
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
      let usedDays = DAYS;
      let videos = await gather(cat, DAYS);

      if(videos.length < MIN_RESULTS && cat.type !== 'chart'){
        console.log(`${cat.name}: ${videos.length}개뿐 -> ${FALLBACK_DAYS}일로 재시도`);
        const wider = await gather(cat, FALLBACK_DAYS);
        if(wider.length > videos.length){
          videos = wider;
          usedDays = FALLBACK_DAYS;
        }
      }

      result.categories[cat.id] = {
        name: cat.name,
        windowDays: usedDays,
        videos,
        stats: analyze(videos)
      };

      console.log(`${cat.name}: ${videos.length}개 수집 (최근 ${usedDays}일)`);
    }catch(e){
      console.error(`${cat.name} 실패: ${e.message}`);
      result.categories[cat.id] = { name: cat.name, videos: [], stats: null, error: e.message };
    }
  }

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
