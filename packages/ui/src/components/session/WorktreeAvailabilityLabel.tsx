import { useI18n } from '@/lib/i18n';
import type { WorktreeAvailability } from '@/lib/worktrees/worktreeAvailability';

export function WorktreeAvailabilityLabel({ availability }: { availability: WorktreeAvailability }) {
  const { t } = useI18n();
  if (availability.status === 'available') return null;
  return <span className="block typography-micro text-muted-foreground">
    {availability.status === 'exists' ? <>
      <span className="text-status-warning">{t('session.worktreeAvailability.exists')}</span>
      <span className="block break-all">{availability.path}</span>
    </> : t(availability.status === 'checking'
      ? 'session.worktreeAvailability.checking'
      : availability.status === 'error'
        ? 'session.worktreeAvailability.failed'
        : 'session.worktreeAvailability.unavailable')}
  </span>;
}
