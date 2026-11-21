export interface CustomerProfileDto {
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  phoneMasked: string | null;
  phoneVerified: boolean;
}
