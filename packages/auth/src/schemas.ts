import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const SignupSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'Senha deve ter pelo menos 8 caracteres'),
});
export type SignupInput = z.infer<typeof SignupSchema>;

export const CreateClinicSchema = z.object({
  name: z.string()
    .min(2, 'Nome da clínica deve ter pelo menos 2 caracteres')
    .max(100, 'Nome da clínica deve ter no máximo 100 caracteres'),
  slug: z.string()
    .min(3, 'Slug deve ter pelo menos 3 caracteres')
    .max(50, 'Slug deve ter no máximo 50 caracteres')
    .regex(/^[a-z0-9-]+$/, 'Slug deve conter apenas letras minúsculas, números e hífens'),
});
export type CreateClinicInput = z.infer<typeof CreateClinicSchema>;
