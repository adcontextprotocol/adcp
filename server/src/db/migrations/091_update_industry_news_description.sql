-- Migration: Update Industry Agentic News channel description
-- Make the description more specific to advertising-related content only

UPDATE notification_channels
SET description = 'Articles about agentic AI specifically in advertising. Anything about AAO, AdCP, or companies building on top of AdCP for advertising media buying, creative, signals, audiences, and measurement. This channel should NOT include: generic AI/LLM news, agent frameworks (LangChain, CrewAI, etc.), or agentic protocols for non-advertising industries (e-commerce, customer service, healthcare, etc.). Only content directly related to AI agents in advertising belongs here.',
    updated_at = NOW()
WHERE name = 'Industry Agentic News';
