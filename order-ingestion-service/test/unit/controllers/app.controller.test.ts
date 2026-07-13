import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../../../src/controllers/app.controller';
import { AppService } from '../../../src/services/app.service';

describe(AppController.name, () => {
  let controller: AppController;
  let mockService: AppService;

  beforeEach(() => {
    mockService = { getHello: vi.fn() };
    controller = new AppController(mockService);
  });

  describe('getHello', () => {
    it('should wrap the service message in the standard envelope', () => {
      vi.spyOn(mockService, 'getHello').mockReturnValue('welcome message');

      const actualResult = controller.getHello();

      expect(actualResult).toEqual({ message: 'welcome message', data: null });
    });
  });
});
