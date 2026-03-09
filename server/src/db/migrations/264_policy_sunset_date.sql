-- Add sunset_date column to policies table
ALTER TABLE policies ADD COLUMN IF NOT EXISTS sunset_date TEXT;
