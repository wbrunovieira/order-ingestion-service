import { Controller, Get } from '@nestjs/common';
import { AppService } from '../services/app.service';
import { success, SuccessResponse } from '../utils/http-response';

@Controller('api/v1')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): SuccessResponse<null> {
    return success(this.appService.getHello(), null);
  }
}
