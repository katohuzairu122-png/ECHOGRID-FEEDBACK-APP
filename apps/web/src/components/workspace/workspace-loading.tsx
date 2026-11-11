import { getTranslations } from 'next-intl/server';
import styles from './workspace.module.css';

export default async function WorkspaceLoading() {
  const t = await getTranslations('common.workspace');
  return (
    <section className={styles.loading} role="status" aria-busy="true">
      <p>{t('loading')}</p>
      <div aria-hidden="true" />
      <div aria-hidden="true" />
    </section>
  );
}
