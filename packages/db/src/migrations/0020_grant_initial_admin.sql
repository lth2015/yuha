-- Grant the existing owner accounts administrator access.
UPDATE users SET role = 'admin' WHERE email IN ('lth9739@gmail.com', 'pan.xinyuan@netstars.co.jp');
