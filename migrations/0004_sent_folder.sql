-- Move only outgoing-only Inbox conversations. Received mail and user-filed
-- Archive, Trash, Spam, and quarantine conversations retain their folders.
UPDATE threads
SET folder = 'sent'
WHERE folder = 'inbox'
  AND EXISTS (
    SELECT 1 FROM messages
    WHERE messages.thread_id = threads.id AND messages.direction = 'outbound'
  )
  AND NOT EXISTS (
    SELECT 1 FROM messages
    WHERE messages.thread_id = threads.id AND messages.direction = 'inbound'
  );
