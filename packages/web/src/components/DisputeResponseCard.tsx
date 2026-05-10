import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { formatDate, disputeReasonLabel } from '@/lib/format';
import type { InterventionDispute } from '@/queries/types';

const responseSchema = z.object({
  tenantResponse: z
    .string()
    .min(20, 'La risposta deve essere di almeno 20 caratteri.')
    .max(2000, 'La risposta non puo superare i 2000 caratteri.'),
});
type ResponseFormValues = z.infer<typeof responseSchema>;

interface Props {
  dispute: InterventionDispute;
  // Async so the parent can await invalidation before resetting the form.
  // Throwing inside onSubmit lets the form keep its values for retry.
  onSubmit: (response: string) => Promise<void>;
}

export function DisputeResponseCard({ dispute, onSubmit }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<ResponseFormValues>({
    resolver: zodResolver(responseSchema),
    defaultValues: { tenantResponse: '' },
    mode: 'onChange',
  });

  const value = form.watch('tenantResponse') ?? '';

  async function handleSubmit(values: ResponseFormValues) {
    setSubmitting(true);
    try {
      await onSubmit(values.tenantResponse);
      form.reset({ tenantResponse: '' });
    } catch {
      // Parent shows toast; keep form values for retry.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{disputeReasonLabel(dispute.reasonCategory)}</Badge>
            <Badge variant="destructive">Aperta</Badge>
          </div>
          <span className="text-xs text-muted-foreground">{formatDate(dispute.createdAt)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Cliente</div>
          <p className="whitespace-pre-line">{dispute.customerDescription}</p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-3">
            <FormField
              control={form.control}
              name="tenantResponse"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Risposta dell'officina (min 20 caratteri)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Scrivi qui la risposta che il cliente vedra..."
                      className="min-h-32"
                      maxLength={2000}
                      disabled={submitting}
                    />
                  </FormControl>
                  <div className="flex items-center justify-between">
                    <FormMessage />
                    <span className="text-xs text-muted-foreground">{value.length} / 2000</span>
                  </div>
                </FormItem>
              )}
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={submitting || !form.formState.isValid}>
                {submitting ? 'Invio in corso...' : 'Invia risposta'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
