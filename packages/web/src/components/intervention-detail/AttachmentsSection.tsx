import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes, formatDate } from '@/lib/format';
import { useAttachmentViewUrl } from '@/queries/interventionDetail';
import type { InterventionAttachment } from '@/queries/types';

interface Props {
  attachments: InterventionAttachment[];
}

/**
 * Attachments card for the intervention detail page. Lazy-presigns each
 * download URL on click (no eager presign at page load — fresh URLs per
 * click + zero waste on attachments the user never opens). Opens in a
 * new tab with noopener,noreferrer for security.
 *
 * Returns null when there are no attachments — hides the card entirely
 * to keep the page uncluttered for the common case (no attached files).
 */
export function AttachmentsSection({ attachments }: Props) {
  const viewUrl = useAttachmentViewUrl();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const handleShow = async (id: string) => {
    setBusyId(id);
    try {
      const { url } = await viewUrl.mutateAsync(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error("Impossibile aprire l'allegato.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Allegati ({attachments.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between py-2 gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">{a.file_name}</div>
                <div className="text-xs text-muted-foreground">
                  {formatBytes(a.size_bytes)} · {formatDate(a.created_at)}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleShow(a.id)}
                disabled={busyId === a.id}
              >
                {busyId === a.id ? 'Apertura…' : 'Mostra'}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
