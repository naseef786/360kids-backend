ALTER TABLE app.children ALTER COLUMN surname SET DEFAULT '';
ALTER TABLE app.children ALTER COLUMN birth_date DROP NOT NULL;
ALTER TABLE app.children ADD COLUMN age_years integer CHECK(age_years BETWEEN 0 AND 17);
ALTER TABLE app.children ADD COLUMN age_recorded_on date;
ALTER TABLE app.children ADD CONSTRAINT child_age_source CHECK(
  (birth_date IS NOT NULL AND age_years IS NULL AND age_recorded_on IS NULL)
  OR (birth_date IS NULL AND age_years IS NOT NULL AND age_recorded_on IS NOT NULL)
);
