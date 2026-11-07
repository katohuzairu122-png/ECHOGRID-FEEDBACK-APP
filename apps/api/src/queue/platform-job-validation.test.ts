import { describe, expect, it } from 'vitest';
import { isPlatformJob } from './platform-job-validation';

describe('DEV-46 runtime queue validation', () => {
  const cases = [
    {type:'classify_feedback', feedbackId:'f1', businessId:'b1'},
    {type:'generate_summary', businessId:'b1', periodType:'daily', periodStart:'2026-11-01T00:00:00Z', periodEnd:'2026-11-02T00:00:00Z'},
    {type:'send_notification',businessId:'b1',eventType:'summary_ready',channel:'email',recipientAddress:'user@example.com',subject:'Ready',body:'Summary'},
    {type:'escalate_critical_incident',incidentId:'i1',businessId:'b1'},
  ];
  it.each(cases)('accepts valid $type', value => expect(isPlatformJob(value)).toBe(true));
  it.each([null,undefined,[],{},'hello',{type:'unknown'},{type:'classify_feedback',feedbackId:'f1'}, {type:'classify_feedback',feedbackId:'f1',businessId:'b1',extra:true}, {type:'generate_summary',businessId:'b1',periodType:'yearly',periodStart:'x',periodEnd:'y'}, {type:'generate_summary',businessId:'b1',periodType:'daily',periodStart:'2026-11-02',periodEnd:'2026-11-01'}, {type:'send_notification',businessId:'b1',eventType:'summary_ready',channel:'push',recipientAddress:'x',body:'x'}, {type:'escalate_critical_incident',incidentId:'',businessId:'b1'}])('rejects malformed payload %#', value => expect(isPlatformJob(value)).toBe(false));
});
