-- REMEMBER WAY AI — 일지 알림 저장소 (Supabase → SQL Editor → 붙여넣고 Run, 한 번만)
-- 저장하는 것: 푸시 구독 주소와 마지막 일지 날짜뿐. 이름·주소·일지 내용은 저장하지 않는다.
create table if not exists push_subs (
  id       text primary key,          -- 구독 주소의 해시 (원래 주소를 키로 쓰지 않음)
  endpoint text not null,
  p256dh   text not null,
  auth     text not null,
  last     date,                      -- 마지막으로 일지를 쓴 날 (이 날이 오늘이면 알림 안 보냄)
  created  timestamptz default now()
);
create table if not exists app_kv (
  key   text primary key,             -- 'vapid' : 알림 서명 키 한 쌍 (서버만 사용)
  value text not null
);
-- 브라우저용 공개 키(anon)로는 읽기·쓰기 불가. 서버 함수는 service_role 키로만 접근.
alter table push_subs enable row level security;
alter table app_kv    enable row level security;
