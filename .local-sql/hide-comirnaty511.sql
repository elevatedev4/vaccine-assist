-- Hide Pfizer 5-11 until the new code is live (reversible: set active = true).
update vaccine set active = false, updated_at = now() where short_code = 'comirnaty511';
