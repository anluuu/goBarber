import Appointment from "../models/Appointment";
import * as Yup from 'yup';
import { startOfHour, parseISO, isBefore, format, subHours } from "date-fns";
import pt from 'date-fns/locale/pt';
import User from '../models/User'
import File from "../models/File";
import Notification from "../schemas/Notification";
import Queue from "../../lib/Queue";
import CancellationMail from "../jobs/CancellationMail";


class AppointmentController {

  async index (req,res) {

    const { page = 1 } = req.query;

    const appointments = await Appointment.findAll({
      where: {user_id: req.userId, canceled_at: null},
      order: ['date'],
      attributes: ['id', 'date', 'past', 'cancelable'],
      limit: 20,
      offset: (page -1) * 20,
      include: {
        model: User,
        as: 'provider',
        attributes: ['id', 'name'],
        include: [
          {
            model: File,
            as: 'avatar',
            attributes: ['id', 'url', 'path']
          }
        ]
      }
    });

    return res.status(200).json(appointments);
  }


  async store(req,res) {
    const schema = Yup.object().shape({
      provider_id: Yup.number().required(),
      date: Yup.date().required(),
    });

    if (!(await schema.isValid(req.body))) {
      return res.status(400).json({error: 'Validations fails'});
    }

    const { provider_id, date } = req.body;

    if (provider_id === req.userId) {
      return res.status(401).json({ error: 'You cant create a appointment with yourself' });
    }

    //Check if provider_id is a provider
    const isProvider = await User.findOne({where:  {id: provider_id, provider: true}});

    if (!isProvider) {
      return res.status(401).json({
        error: 'You can only create appointments with providers'
      });
    }

    //Check for past dates

    const hourStart = startOfHour(parseISO(date));

    if (isBefore(hourStart, new Date())) {
      return res.status(400).json({ error: 'Past dates are not permitted' });
    }

    //Check date Availability

    const checkAvailability = await Appointment.findOne({
      where: {
        provider_id,
        canceled_at: null,
        date: hourStart
      },
    });

    if (checkAvailability) {
      return res
        .status(400)
        .json({ error: 'Appointment date is not available' });
    }

    const appointments = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date
    });

    /**
     * Notify Provider
     */

    const user = await User.findByPk(req.userId);
    const formattedDate = format(hourStart, "'Dia' dd 'de' MMMM', às' H:mm'h'", {locale: pt});

    await Notification.create({
      content: `Novo Agendamento de ${user.name} para ${formattedDate}`,
      user: provider_id,
    });

    return res.json(appointments)

  }

  async delete(req,res) {
    const appointments = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email']
        },
        {
          model: User,
          as: 'user',
          attributes: ['name']
        }
      ]
    });

    if (appointments.user_id !== req.userId) {
      return res.status(401).json({
        error: "You don't have permission to cancel this appointment"
      });
    }

    const dateWithSub = subHours(appointments.date, 2);

    if (isBefore(dateWithSub, new Date())) {
      return res.status(401).json({
        error: 'You can only cancel appointments 2 hours in advance.'
      })
    }

    appointments.canceled_at = new Date();

    await appointments.save();

    Queue.add(CancellationMail.key, { appointments });



    return res.status(200).json(appointments)
  }

}

export default new AppointmentController();