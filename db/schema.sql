create extension if not exists "uuid-ossp";

create table if not exists expenses (
  id uuid primary key default uuid_generate_v4(),
  date date not null default current_date,
  amount numeric(14,2) not null,
  currency text not null default 'MMK',
  category text not null default 'Other',
  merchant text,
  note text,
  entered_by text,
  source text not null default 'manual',       -- 'manual' | 'telegram_photo' | 'telegram_text' | 'artifact'
  telegram_user_id bigint,
  telegram_chat_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists idx_expenses_date on expenses (date);
create index if not exists idx_expenses_category on expenses (category);

create table if not exists settings (
  id smallint primary key default 1,
  currency text not null default 'MMK',
  members text[] not null default '{}'
);
insert into settings (id) values (1) on conflict (id) do nothing;

create table if not exists api_usage (
  id uuid primary key default uuid_generate_v4(),
  input_tokens integer not null,
  output_tokens integer not null,
  purpose text,                                  -- 'receipt' | 'text'
  created_at timestamptz not null default now()
);
create index if not exists idx_api_usage_created on api_usage (created_at);
