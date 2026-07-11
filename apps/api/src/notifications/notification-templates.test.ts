import { describe, it, expect } from 'vitest';
import { renderNotification } from './notification-templates';

describe('renderNotification', () => {
  describe('feedback_received', () => {
    it('renders a filled/empty star string matching the rating', () => {
      const result = renderNotification({
        eventType: 'feedback_received',
        businessName: 'Test Biz',
        branchName: 'Main St',
        rating: 4,
        comment: 'Great service',
      });

      expect(result.emailHtml).toContain('★★★★☆');
    });

    it('shows the comment quoted in the email and raw (truncated) in the SMS', () => {
      const result = renderNotification({
        eventType: 'feedback_received',
        businessName: 'Test Biz',
        branchName: 'Main St',
        rating: 5,
        comment: 'Loved it',
      });

      expect(result.emailHtml).toContain('"Loved it"');
      expect(result.smsText).toContain('Loved it');
    });

    it('falls back to a placeholder when there is no comment, worded differently per channel', () => {
      const result = renderNotification({
        eventType: 'feedback_received',
        businessName: 'Test Biz',
        branchName: 'Main St',
        rating: 3,
      });

      expect(result.emailHtml).toContain('(no comment left)');
      expect(result.smsText).toContain('(no comment)');
    });

    it('truncates a long comment to 100 characters in the SMS but not in the email', () => {
      const longComment = 'x'.repeat(150);
      const result = renderNotification({
        eventType: 'feedback_received',
        businessName: 'Test Biz',
        branchName: 'Main St',
        rating: 2,
        comment: longComment,
      });

      expect(result.smsText).toContain('x'.repeat(100));
      expect(result.smsText).not.toContain('x'.repeat(101));
      expect(result.emailHtml).toContain(longComment);
    });

    it('HTML-escapes business name, branch name, and comment in the email -- public unauthenticated input', () => {
      const result = renderNotification({
        eventType: 'feedback_received',
        businessName: '<script>alert(1)</script>',
        branchName: 'A & B Branch',
        rating: 1,
        comment: '<img src=x onerror=alert(1)>',
      });

      expect(result.emailHtml).not.toContain('<script>');
      expect(result.emailHtml).toContain('&lt;script&gt;');
      expect(result.emailHtml).toContain('A &amp; B Branch');
      expect(result.emailHtml).not.toContain('<img src=x');
      expect(result.emailHtml).toContain('&lt;img');
    });

    it('does not escape the SMS body -- plain text has no injection surface', () => {
      const result = renderNotification({
        eventType: 'feedback_received',
        businessName: 'Test Biz',
        branchName: '<b>Main</b>',
        rating: 5,
        comment: 'A & B',
      });

      // smsText only interpolates branchName/rating/comment directly, no escapeHtml call
      expect(result.smsText).toContain('<b>Main</b>');
    });
  });

  it('summary_ready includes the business name and period label in every field', () => {
    const result = renderNotification({
      eventType: 'summary_ready',
      businessName: 'Test Biz',
      periodLabel: 'Jul 1 – Jul 8',
    });

    expect(result.subject).toContain('Test Biz');
    expect(result.emailHtml).toContain('Jul 1 – Jul 8');
    expect(result.smsText).toContain('Jul 1 – Jul 8');
  });

  it('redemption_pending includes the reward name and redemption code, escaped in the email', () => {
    const result = renderNotification({
      eventType: 'redemption_pending',
      businessName: 'Test Biz',
      rewardName: '<b>Free Coffee</b>',
      redemptionCode: 'ABC123',
    });

    expect(result.subject).toContain('Redemption waiting');
    expect(result.emailHtml).toContain('&lt;b&gt;Free Coffee&lt;/b&gt;');
    expect(result.emailHtml).toContain('ABC123');
    expect(result.smsText).toContain('ABC123');
  });

  it('points_earned includes the points earned and new balance', () => {
    const result = renderNotification({
      eventType: 'points_earned',
      businessName: 'Test Biz',
      pointsEarned: 25,
      newBalance: 340,
    });

    expect(result.subject).toContain('25');
    expect(result.emailHtml).toContain('340');
    expect(result.smsText).toContain('25');
    expect(result.smsText).toContain('340');
  });

  it('tier_upgraded includes the tier name, escaped in the email', () => {
    const result = renderNotification({
      eventType: 'tier_upgraded',
      businessName: 'Test Biz',
      tierName: 'Gold & Platinum',
    });

    expect(result.emailHtml).toContain('Gold &amp; Platinum');
    expect(result.smsText).toContain('Gold & Platinum');
  });

  it('reward_redeemed includes the reward name, escaped in the email', () => {
    const result = renderNotification({
      eventType: 'reward_redeemed',
      businessName: 'Test Biz',
      rewardName: '10% Off <Sale>',
    });

    expect(result.emailHtml).toContain('10% Off &lt;Sale&gt;');
    expect(result.smsText).toContain('10% Off <Sale>');
  });

  it('every event type returns a non-empty subject, emailHtml, and smsText', () => {
    const cases = [
      { eventType: 'feedback_received' as const, businessName: 'B', branchName: 'Br', rating: 5 },
      { eventType: 'summary_ready' as const, businessName: 'B', periodLabel: 'P' },
      { eventType: 'redemption_pending' as const, businessName: 'B', rewardName: 'R', redemptionCode: 'C' },
      { eventType: 'points_earned' as const, businessName: 'B', pointsEarned: 1, newBalance: 1 },
      { eventType: 'tier_upgraded' as const, businessName: 'B', tierName: 'T' },
      { eventType: 'reward_redeemed' as const, businessName: 'B', rewardName: 'R' },
    ];

    for (const data of cases) {
      const result = renderNotification(data);
      expect(result.subject.length).toBeGreaterThan(0);
      expect(result.emailHtml.length).toBeGreaterThan(0);
      expect(result.smsText.length).toBeGreaterThan(0);
    }
  });
});
