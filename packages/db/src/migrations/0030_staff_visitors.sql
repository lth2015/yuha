-- Browsers known to belong to staff, by the anonymous visitor id the web app
-- keeps in localStorage. A page view used to count as internal only while
-- staff were signed in, so an operator's own signed-out browsing — the
-- sign-in page, the two-step page, a look at the site from home — counted as
-- outside visitors. Once a browser has signed in as staff, every page view
-- from it is internal, before and after.
CREATE TABLE staff_visitors (
  visitor_ref  VARCHAR(191) NOT NULL,
  first_seen   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (visitor_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
-- ;;

-- The browsers already known: outside the demo, an internal page view made
-- while signed in was made by staff.
INSERT IGNORE INTO staff_visitors (visitor_ref, first_seen)
SELECT user_ref, MIN(occurred_at)
  FROM analytics_events
 WHERE name = 'page_view' AND is_internal = 1 AND run_mode <> 'demo'
   AND user_ref IS NOT NULL
   AND JSON_EXTRACT(props, '$.signed_in') = true
 GROUP BY user_ref
-- ;;

UPDATE analytics_events
   SET is_internal = 1
 WHERE name = 'page_view' AND is_internal = 0
   AND user_ref IN (SELECT visitor_ref FROM staff_visitors)
