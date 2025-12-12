-- Join Requests Table
-- Tracks pending requests from users wanting to join organizations

CREATE TABLE IF NOT EXISTS organization_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who is requesting
  workos_user_id VARCHAR(255) NOT NULL,
  user_email VARCHAR(255) NOT NULL,

  -- Which organization they want to join
  workos_organization_id VARCHAR(255) NOT NULL REFERENCES organizations(workos_organization_id) ON DELETE CASCADE,

  -- Request status
  status VARCHAR(50) NOT NULL DEFAULT 'pending',  -- pending, approved, rejected, cancelled

  -- Admin who handled the request (if any)
  handled_by_user_id VARCHAR(255),
  handled_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,

  -- Lifecycle
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Prevent duplicate pending requests
  CONSTRAINT unique_pending_request UNIQUE (workos_user_id, workos_organization_id, status)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_join_requests_user ON organization_join_requests(workos_user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_org ON organization_join_requests(workos_organization_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_status ON organization_join_requests(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_requests_email ON organization_join_requests(user_email);

-- Trigger for updated_at
CREATE TRIGGER update_join_requests_updated_at
  BEFORE UPDATE ON organization_join_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
