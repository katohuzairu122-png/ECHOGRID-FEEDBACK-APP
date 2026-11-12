import { managementGate } from '@/lib/workspace-guard';

export default async function Layout({ children }: { children: React.ReactNode }) {
  return (await managementGate()) ?? children;
}
