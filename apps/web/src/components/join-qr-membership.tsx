'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { joinLoyaltyAction } from '@/lib/actions/loyalty-customer';
import { Button } from '@/components/ui';

export function JoinQrMembership({ token }: { token: string }) {
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="max-w-sm space-y-3 rounded-lg border p-4">
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        I agree to join this business’s loyalty program (consent v1).
      </label>
      <Button
        disabled={!consent || pending}
        onClick={() =>
          start(async () => {
            try {
              await joinLoyaltyAction(token);
              router.refresh();
            } catch {
              setError('Unable to join. Sign in again or retry this QR.');
            }
          })
        }
      >
        Join loyalty
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
