// 오늘의 밥 메뉴 데이터 — 이 파일만 고치면 추천 메뉴가 바뀐다.
// conds: 어울리는 날씨 (아래 WEATHER_CONDS의 id), 여러 개 가능
// q: 카카오 검색어가 메뉴 이름과 달라야 할 때만 적는다 (없으면 이름으로 검색)

window.WEATHER_CONDS = [
  { id: "rain", label: "비", emoji: "🌧️" },
  { id: "snow", label: "눈·영하", emoji: "❄️" },
  { id: "cold", label: "쌀쌀함", range: "0~10℃", emoji: "🧣" },
  { id: "mild", label: "선선함", range: "11~22℃", emoji: "🍃" },
  { id: "warm", label: "따뜻함", range: "23~27℃", emoji: "☀️" },
  { id: "hot", label: "더움", range: "28℃ 이상", emoji: "🔥" },
  { id: "always", label: "언제나", emoji: "🍚" },
];

window.MENUS = [
  // 비
  { name: "칼국수", conds: ["rain"] },
  { name: "짬뽕", conds: ["rain"] },
  { name: "수제비", conds: ["rain"] },
  { name: "부대찌개", conds: ["rain"] },
  { name: "파전", conds: ["rain"] },
  // 눈 / 영하
  { name: "국밥", conds: ["snow"] },
  { name: "순대국", conds: ["snow"] },
  { name: "감자탕", conds: ["snow"] },
  { name: "우동", conds: ["snow"] },
  { name: "김치찌개", conds: ["snow"] },
  // 0~10℃
  { name: "찌개류", q: "찌개", conds: ["cold"] },
  { name: "갈비탕", conds: ["cold"] },
  { name: "라멘", conds: ["cold"] },
  { name: "쌀국수", conds: ["cold", "warm"] },
  // 11~22℃
  { name: "제육볶음", conds: ["mild"] },
  { name: "돈까스", conds: ["mild"] },
  { name: "비빔밥", conds: ["mild"] },
  { name: "백반", conds: ["mild"] },
  { name: "덮밥", conds: ["mild"] },
  // 23~27℃
  { name: "메밀", conds: ["warm"] },
  { name: "샐러드", conds: ["warm"] },
  { name: "초밥", conds: ["warm"] },
  // 28℃ 이상
  { name: "냉면", conds: ["hot"] },
  { name: "콩국수", conds: ["hot"] },
  { name: "밀면", conds: ["hot"] },
  { name: "물회", conds: ["hot"] },
  { name: "냉모밀", conds: ["hot"] },
  // 언제나
  { name: "김밥", conds: ["always"] },
  { name: "햄버거", conds: ["always"] },
  { name: "중식", conds: ["always"] },
  { name: "분식", conds: ["always"] },
];
