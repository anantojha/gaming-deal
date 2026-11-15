-- TEST DATA ONLY. Run AFTER creating a user (Supabase dashboard → Authentication → Add user);
-- the on_auth_user_created trigger creates their user_profile row automatically.
insert into product (itad_id, steam_appid, title)
values ('018d937f-21e1-728e-86d7-9acb3c59f2bb', 620, 'Portal 2')
on conflict (itad_id) do nothing;

insert into watch (user_id, product_id, target_price_cents)
select (select id from user_profile order by created_at limit 1), id, 500
from product where steam_appid = 620
on conflict (user_id, product_id) do nothing;
