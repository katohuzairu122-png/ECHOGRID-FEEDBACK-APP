import { describe, it, expect } from 'vitest';
import { classifyCategory, classifyUrgency } from './feedback-classifier';

describe('classifyCategory', () => {
  it('returns other for a missing or empty comment -- nothing to infer from', () => {
    expect(classifyCategory(undefined, 5)).toBe('other');
    expect(classifyCategory('   ', 3)).toBe('other');
  });

  it('matches staff conduct language', () => {
    expect(classifyCategory('The waiter was so rude to us the whole time.', 1)).toBe('staff_conduct');
  });

  it('matches cleanliness language', () => {
    expect(classifyCategory('The tables were filthy and the whole place smelled bad.', 1)).toBe('cleanliness');
  });

  it('matches waiting time language', () => {
    expect(classifyCategory('We waited 45 minutes just to be seated.', 2)).toBe('waiting_time');
  });

  it('matches pricing language', () => {
    expect(classifyCategory('Way too expensive for what you get, total rip-off.', 2)).toBe('pricing');
  });

  it('matches payment language', () => {
    expect(classifyCategory('I was overcharged and the billing error was never fixed.', 1)).toBe('payment');
  });

  it('matches safety language', () => {
    expect(classifyCategory('The floor was wet and I nearly slipped, seems unsafe.', 2)).toBe('safety');
  });

  it('matches loyalty/reward language', () => {
    expect(classifyCategory('My points never showed up after redeeming the reward.', 3)).toBe('loyalty_or_reward');
  });

  it('falls back to compliment for a high rating with no keyword match', () => {
    expect(classifyCategory('Just a wonderful experience all around, thank you!', 5)).toBe('compliment');
  });

  it('falls back to complaint for a low rating with no keyword match', () => {
    expect(classifyCategory('Really not happy with how things went today.', 1)).toBe('complaint');
  });

  it('falls back to suggestion for a middling rating with no keyword match', () => {
    expect(classifyCategory('It was okay, could be improved I think.', 3)).toBe('suggestion');
  });
});

describe('classifyUrgency', () => {
  it('never returns P0_CRITICAL -- that is Level 1 critical-detector.ts\'s job only', () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      for (const sentiment of ['very_negative', 'negative', 'neutral', 'positive', 'very_positive', 'unknown'] as const) {
        expect(classifyUrgency(rating, sentiment, 'other')).not.toBe('P0_CRITICAL');
      }
    }
  });

  it('elevates a safety-categorized item to P1_HIGH regardless of rating', () => {
    expect(classifyUrgency(5, 'positive', 'safety')).toBe('P1_HIGH');
  });

  it('maps a low rating or negative sentiment to P1_HIGH', () => {
    expect(classifyUrgency(1, 'very_negative', 'other')).toBe('P1_HIGH');
    expect(classifyUrgency(4, 'negative', 'other')).toBe('P1_HIGH');
  });

  it('maps a middling rating or neutral sentiment to P2_NORMAL', () => {
    expect(classifyUrgency(3, 'neutral', 'other')).toBe('P2_NORMAL');
  });

  it('maps a high rating with positive sentiment to P3_LOW', () => {
    expect(classifyUrgency(5, 'very_positive', 'other')).toBe('P3_LOW');
  });
});
