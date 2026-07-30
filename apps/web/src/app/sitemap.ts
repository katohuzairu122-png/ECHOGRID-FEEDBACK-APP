import type { MetadataRoute } from 'next';
import { APP_URL } from '@/lib/app-url';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: APP_URL, lastModified, changeFrequency: 'monthly', priority: 1 },
    { url: `${APP_URL}/login`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${APP_URL}/signup`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
  ];
}
