import { describe, it, expect } from 'vitest';
import { detectCriticalSignals } from './critical-detector';

describe('detectCriticalSignals', () => {
  it('returns no match for an empty or missing comment', () => {
    expect(detectCriticalSignals(undefined)).toEqual({ isCritical: false, matchedSignals: [] });
    expect(detectCriticalSignals(null)).toEqual({ isCritical: false, matchedSignals: [] });
    expect(detectCriticalSignals('   ')).toEqual({ isCritical: false, matchedSignals: [] });
  });

  it('returns no match for ordinary negative feedback -- a bad experience is not an emergency', () => {
    const result = detectCriticalSignals('The food was cold and the waiter was rude. Terrible service, would not return.');
    expect(result.isCritical).toBe(false);
    expect(result.matchedSignals).toEqual([]);
  });

  it('detects a fire signal', () => {
    const result = detectCriticalSignals('There\'s a fire in the kitchen, everyone needs to leave now.');
    expect(result.isCritical).toBe(true);
    expect(result.matchedSignals).toContain('fire');
  });

  it('detects an assault signal', () => {
    const result = detectCriticalSignals('One of your staff assaulted my son in the parking lot.');
    expect(result.isCritical).toBe(true);
    expect(result.matchedSignals).toContain('assault');
  });

  it('detects food poisoning', () => {
    const result = detectCriticalSignals('My whole family has food poisoning after eating here last night.');
    expect(result.isCritical).toBe(true);
    expect(result.matchedSignals).toContain('food_poisoning');
  });

  it('detects a severe allergic reaction', () => {
    const result = detectCriticalSignals('My daughter is having an anaphylactic reaction, she needs an epipen.');
    expect(result.isCritical).toBe(true);
    expect(result.matchedSignals).toContain('severe_allergic_reaction');
  });

  it('detects a medical emergency', () => {
    const result = detectCriticalSignals('A customer just collapsed and is not breathing.');
    expect(result.isCritical).toBe(true);
    expect(result.matchedSignals).toContain('medical_emergency');
  });

  it('detects active fraud', () => {
    const result = detectCriticalSignals('Someone stole my card at checkout and there is a fraudulent charge on my account.');
    expect(result.isCritical).toBe(true);
    expect(result.matchedSignals).toContain('active_fraud');
  });

  it('detects a security incident', () => {
    const result = detectCriticalSignals('A man in the store has a gun and is threatening customers.');
    expect(result.isCritical).toBe(true);
    // Both patterns are legitimately allowed to fire together here (weapon
    // language matches security_incident; the same sentence structure can
    // also plausibly match immediate_danger) -- the point of this test is
    // that the emergency is caught at all, not that exactly one label fires.
    expect(result.matchedSignals.length).toBeGreaterThan(0);
    expect(result.matchedSignals).toContain('security_incident');
  });

  it('can match multiple signals in one comment', () => {
    const result = detectCriticalSignals('There is a fire and someone is unconscious, please call an ambulance.');
    expect(result.matchedSignals).toEqual(expect.arrayContaining(['fire', 'medical_emergency']));
  });

  it('is case-insensitive', () => {
    const result = detectCriticalSignals('THERE IS A FIRE IN THE KITCHEN');
    expect(result.isCritical).toBe(true);
  });
});
