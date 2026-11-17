-- REMEMBER WAY AI — 일지 알림 저장소 (Supabase → SQL Editor → 붙여넣고 Run, 한 번만)
-- 이 부분(일지 알림)이 저장하는 것: 푸시 구독 주소와 마지막 일지 날짜뿐. 일지 내용·이름·집 주소는 저장하지 않는다.
-- (2026-11-17부터 가족이 저장한 정보는 아래 "보호자 계정" 표에 따로 있다. 서버에 남는 사람 정보는 로그인 이메일뿐, 이름·전화번호·집 주소는 받지 않는다.)
-- 이 파일은 몇 번 Run 해도 안전하다 (create ... if not exists). 이미 실행한 적이 있으면 "보호자 계정" 구간부터만 Run 해도 된다.
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

-- ---------------------------------------------------------------- 실시간 위치 중계 (2026-11-16 지도교사 결정, 한 번만 Run)
-- 목걸이 → 어르신 휴대폰 앱 → /api/loc → 여기 → 보호자 웹앱 지도.
-- dev 는 연결 코드의 해시(코드 자체는 저장 안 함). 이름·주소는 저장하지 않는다. 보호자가 [기록 모두 지우기]로 지운다.
create table if not exists loc_events (
  id          bigserial primary key,
  dev         text not null,
  lat         double precision not null,
  lng         double precision not null,
  gps_time    timestamptz,                 -- GPS가 잰 시각 (UTC)
  received_at timestamptz default now(),   -- 서버가 받은 시각
  speed_kmh   double precision,
  fix_age_ms  integer,
  seq         bigint,
  fw          text
);
create index if not exists loc_events_dev_time on loc_events (dev, received_at desc);
alter table loc_events enable row level security;

-- ---------------------------------------------------------------- 보호자 계정 (2026-11-17, 한 번만 Run)
-- 먼저: Supabase → Authentication → Providers → Email 에서 "Confirm email" 을 끈다 (이메일 인증 메일 없이 바로 가입·로그인).
-- 서버에 남는 사람 정보는 로그인 이메일(Supabase Auth)뿐. 이름·전화번호는 받지 않고, 어르신은 호칭(label)만 저장한다.
-- 집 주소·집 좌표, 보호자가 말한 원문 전체는 서버로 보내지 않는다.
-- 어르신 데이터는 owner가 지우거나 마지막 member가 나갈 때만 삭제한다 (자동 삭제는 loc_events 30일뿐).
create table if not exists elders (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,                   -- 호칭 (예: "어머니") — 실명 아님
  device_hash text unique,                     -- 목걸이 연결 코드의 해시 (코드 자체는 저장 안 함)
  created_at  timestamptz default now(),
  last_seen   timestamptz default now()
);
create table if not exists elder_members (
  elder_id  uuid not null references elders on delete cascade,
  user_id   uuid not null,                     -- Supabase Auth 사용자 id
  role      text not null check (role in ('owner','member')),  -- owner: 내보내기·어르신 삭제·연결 코드 재발급 / member: 초대까지
  joined_at timestamptz default now(),
  primary key (elder_id, user_id)
);
create index if not exists elder_members_user on elder_members (user_id);   -- "내 어르신 목록"(user_id로 찾기) 속도
create table if not exists elder_data (
  elder_id   uuid primary key references elders on delete cascade,
  profile    jsonb,                            -- 어르신 정보 (집 주소·좌표는 이 폰에만 저장, 여기에 넣지 않음)
  diary      jsonb default '[]',               -- 일지
  incidents  jsonb default '[]',               -- 실종 대응 기록
  updated_at timestamptz default now()
);
create table if not exists invites (
  token_hash text primary key,                 -- 초대 토큰의 해시 (24시간, 1회)
  elder_id   uuid not null references elders on delete cascade,
  created_by uuid,
  expires_at timestamptz not null,
  used_at    timestamptz
);
create table if not exists revoked_devices (
  device_hash text primary key,                -- 재발급·삭제로 막힌 목걸이 연결 코드의 해시
  revoked_at  timestamptz default now()
);
-- 브라우저용 공개 키(anon)로는 읽기·쓰기 불가. 서버 함수는 service_role 키로만 접근 (정책 없음).
alter table elders          enable row level security;
alter table elder_members   enable row level security;
alter table elder_data      enable row level security;
alter table invites         enable row level security;
alter table revoked_devices enable row level security;
