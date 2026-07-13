import { Module } from '@nestjs/common';
import { CustomerRegistryService } from './customer-registry.service';

@Module({
  providers: [CustomerRegistryService],
  exports: [CustomerRegistryService],
})
export class CustomersModule {}
