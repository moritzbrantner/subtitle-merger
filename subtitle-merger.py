import click
import ass

def find_common_beginning_index(s1, s2):
    """Finds the common beginning of two strings."""
    index = 0
    while s1[index] == s2[index]:
        index += 1
        if index == len(s1) or index == len(s2):
            break
    return index

def generate_output_name(primary_input, secondary_input):
    """Generates the output file name based on the input file names.
    Subtitles are assumed to be in the same directory and follow the pattern
    $VIDEO_NAME.$LANGUAGE.ass , where $VIDEO_NAME.mp4 is the name of the video.
    This way it is possible to automatically recognize subtitle files.
    The output name will then be $VIDEO_NAME.$LANGUAGE1+$LANGUAGE2.ass.
    """    
    common_beginning_index = find_common_beginning_index(primary_input, secondary_input)
    primary_language = primary_input[common_beginning_index:].split('.')[0]
    secondary_language = secondary_input[common_beginning_index:].split('.')[0]
    return primary_input[:common_beginning_index] + primary_language + '+' + secondary_language + '.ass'    

@click.command()
@click.option('--scale', default=0.8, help='The factor, by which the subtitles should be scaled.')
@click.option('--primary-input', help='The primary subtitle file, onto which another file is to be added.')
@click.option('--secondary-input', help='The secondary subtitle file, to be added onto the primary file.')
@click.option('--output', default=None, help='Output file name. By default tries to be the combination of the input files.')
@click.option('--encoding', default='utf_8_sig', help='Encoding of the input and output files.')
def add_subtitles(scale, primary_input, secondary_input, output, encoding):
    """Simple program that adds one subtitle file onto another.
    This way, watching a movie with subtitles is easier, since you
    have an easier time making out what is said and seeing how it translates."""

    primary_source = None
    with open(primary_input, encoding=encoding) as primary_file:
        primary_source = ass.parse(primary_file)

    secondary_source = None
    with open(secondary_input, encoding=encoding) as secondary_file:
        secondary_source = ass.parse(secondary_file)
    
    primary_styles = primary_source.styles
    
    for style in primary_styles:
        style.margin_v -= 10
        style.scale_x *= scale
        style.scale_y *= scale

    secondary_styles = secondary_source.styles
    for style in secondary_styles:
        style.name += '1'
        style.scale_x *= scale
        style.scale_y *= scale
        style.margin_v += 10
        primary_styles.append(style)

# Format: ,ScaleX,ScaleY,Spacing,Angle
# ,BorderStyle,Outline,Shadow
# ,Alignment,MarginL,MarginR,MarginV
# ,Encoding
# Style:  ,100,100,0,0,
# 1,2,0
# ,2,0000,0000,0020
# ,1

    primary_events = primary_source.events
    secondary_events = secondary_source.events

    length = len(primary_events)
    output_events = []
    for index in range(length):
        event = primary_events[index]
        output_events.append(event)
        if(index < len(secondary_events) - 1):
            secondary_event = secondary_events[index]
            secondary_event.style += '1'
            output_events.append(secondary_event)

    # write the file
    if output is None:
        output = generate_output_name(primary_input, secondary_input)
        
    with open(output, 'w', encoding='utf_8_sig') as f:
        primary_source.events = output_events
        primary_source.dump_file(f)

if __name__ == '__main__':
    add_subtitles()