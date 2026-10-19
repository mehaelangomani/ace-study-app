-- RLS reference — compare with Supabase Dashboard → Authentication → Policies
-- Do NOT run blindly if policies already exist (use IF NOT EXISTS patterns or manual review).
-- Standard pattern: auth.uid() = user_id for select/insert/update/delete on user-owned rows.

-- study_sets
-- alter table public.study_sets enable row level security;
-- create policy "study_sets_select_own" on public.study_sets for select to authenticated using (auth.uid() = user_id);
-- create policy "study_sets_insert_own" on public.study_sets for insert to authenticated with check (auth.uid() = user_id);
-- create policy "study_sets_update_own" on public.study_sets for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- create policy "study_sets_delete_own" on public.study_sets for delete to authenticated using (auth.uid() = user_id);

-- generated_materials (same user_id pattern)
-- quiz_attempts, subscriptions, payment_transactions, usage_events — same pattern on user_id

-- grants (typical):
-- grant select, insert, update, delete on public.study_sets to authenticated;
-- grant select, insert, update, delete on public.generated_materials to authenticated;
