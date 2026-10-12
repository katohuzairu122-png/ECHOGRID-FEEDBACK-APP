import { describe, expect, it } from 'vitest';
import { validateMultiunitMovement } from '../src/partner-credits/multiunit-movement.validation';
import type { LotConservation } from '../src/partner-credits/multiunit-accounting.foundation';

const lot:LotConservation={issuedUnits:3,buckets:{
  provisional:0,available:3,reserved:0,consumed:0,
  expired:0,reversed:0,recoveryOffset:0,
}};
const intent={
  allocationId:'01234567-89ab-4def-8abc-0123456789ab',
  idempotencyKey:'split07:reserve:one',
  from:'available' as const,to:'reserved' as const,units:2,
};
describe('Split 07 non-activating multiunit movement validation',()=>{
  it('proves exact conservation without allowing database execution',()=>{
    const proof=validateMultiunitMovement({lot,intent});
    expect(proof.after.buckets).toMatchObject({available:1,reserved:2});
    expect(proof.after.issuedUnits).toBe(3);
    expect(proof).toMatchObject({issuanceAuthorized:false,executionAuthorized:false});
    expect(lot.buckets.available).toBe(3);
  });
  it('rejects impossible, terminal, zero and overdraft movements',()=>{
    const forbidden=[
      {...intent,from:'consumed' as const,to:'available' as const},
      {...intent,from:'available' as const,to:'consumed' as const},
      {...intent,units:0},
      {...intent,units:4},
      {...intent,idempotencyKey:' '},
    ];
    for(const movement of forbidden)
      expect(()=>validateMultiunitMovement({lot,intent:movement})).toThrow();
  });
  it('rejects incomplete or counterfeit balance conservation',()=>{
    expect(()=>validateMultiunitMovement({
      lot:{...lot,issuedUnits:4},intent,
    })).toThrow('PARTNER_MULTIUNIT_CONSERVATION_FAILURE');
  });
  it('permits release to available while rejecting terminal bucket reuse',()=>{
    const reserved=validateMultiunitMovement({lot,intent}).after;
    const released=validateMultiunitMovement({lot:reserved,intent:{
      ...intent,from:'reserved',to:'available',units:1,idempotencyKey:'release:one',
    }});
    expect(released.after.buckets).toMatchObject({reserved:1,available:2});
  });
});
