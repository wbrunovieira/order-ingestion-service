import { Injectable } from '@nestjs/common';
import type { MapperId } from '../../customers/customer.config';
import { BairroboxMapper } from './mappers/bairrobox.mapper';
import { FreshmartMapper } from './mappers/freshmart.mapper';
import { GlobalgoodsMapper } from './mappers/globalgoods.mapper';
import type { OrderMapper } from './order-mapper';

/**
 * Resolves the mapper a customer's config names.
 *
 * This exists so the pipeline never switches on a customer id. Registering a mapper
 * here and naming it from config is the whole difference between "a new customer is
 * config" and "a new customer is another branch in the pipeline".
 */
@Injectable()
export class MapperRegistryService {
  private readonly mappers: ReadonlyMap<MapperId, OrderMapper>;

  constructor(
    freshmart: FreshmartMapper,
    bairrobox: BairroboxMapper,
    globalgoods: GlobalgoodsMapper,
  ) {
    this.mappers = new Map<MapperId, OrderMapper>([
      ['freshmart', freshmart],
      ['bairrobox', bairrobox],
      ['globalgoods', globalgoods],
    ]);
  }

  /**
   * Throws rather than returning undefined: a config naming a mapper that does not
   * exist is a programmer error at boot, not bad customer data at runtime.
   */
  get(mapperId: MapperId): OrderMapper {
    const mapper = this.mappers.get(mapperId);

    if (mapper === undefined) {
      throw new Error(
        `No mapper registered for "${mapperId}". Register it in MapperRegistryService.`,
      );
    }

    return mapper;
  }
}
